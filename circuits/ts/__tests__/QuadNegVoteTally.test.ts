import * as path from 'path'
import { Circuit } from 'snarkjs'
const compiler = require('circom')
import { config } from 'maci-config'
import { 
    genTallyResultCommitment,
    MaciState,
} from 'maci-core'
import {
    IncrementalMerkleTree,
    genRandomSalt,
    Plaintext,
    bigInt,
    hashOne,
    hash,
    SnarkBigInt,
    NOTHING_UP_MY_SLEEVE,
    stringifyBigInts,
} from 'maci-crypto'

import {
    Keypair,
    StateLeaf,
    Command,
    Message,
} from 'maci-domainobjs'

import {
    compileAndLoadCircuit,
} from '../'

const stateTreeDepth = config.maci.merkleTrees.stateTreeDepth
const messageTreeDepth = config.maci.merkleTrees.messageTreeDepth
const voteOptionTreeDepth = config.maci.merkleTrees.voteOptionTreeDepth
const initialVoiceCreditBalance = config.maci.initialVoiceCreditBalance
const voteOptionsMaxIndex = config.maci.voteOptionsMaxLeafIndex
const quadVoteTallyBatchSize = config.maci.quadVoteTallyBatchSize
const intermediateStateTreeDepth = config.maci.merkleTrees.intermediateStateTreeDepth
const numVoteOptions = 2 ** voteOptionTreeDepth

const randomRange = (min: number, max: number) => {
  return bigInt(Math.floor(Math.random() * (max - min) + min))
}

const emptyVoteOptionTree = new IncrementalMerkleTree(
    voteOptionTreeDepth,
    bigInt(0),
)

const coordinator = new Keypair()

describe('Quadratic vote tallying circuit', () => {
    let circuit 
    const randomStateLeaf = StateLeaf.genRandomLeaf()
    const maciState = new MaciState(
        coordinator,
        stateTreeDepth,
        messageTreeDepth,
        voteOptionTreeDepth,
        voteOptionsMaxIndex,
    )

    beforeAll(async () => {
        circuit = await compileAndLoadCircuit('quadVoteTally_test.circom')
    })

    it('should correctly tally results for 1 user with 1 message in 1 batch', async () => {

        const startIndex = bigInt(0)

        const user = new Keypair()
        // Sign up the user
        maciState.signUp(user.pubKey, initialVoiceCreditBalance)

        // Publish and process a message
        const voteOptionIndex = randomRange(0, voteOptionsMaxIndex)
        const voteWeight = bigInt(-9)
        const command = new Command(
            bigInt(1),
            user.pubKey,
            voteOptionIndex,
            voteWeight,
            bigInt(1),
            genRandomSalt(),
        )

        const signature = command.sign(user.privKey)
        const sharedKey = Keypair.genEcdhSharedKey(user.privKey, coordinator.pubKey)
        const message = command.encrypt(signature, sharedKey)

        // Publish a message
        maciState.publishMessage(message, user.pubKey)

        // Process the message
        maciState.processMessage(0)

		const currentResults = maciState.computeCumulativeVoteTally(startIndex, quadVoteTallyBatchSize)
		console.log("currentResults: ", currentResults)

        // Ensure that the current results are all 0 since this is the first
        // batch
        for (let i = 0; i < currentResults.length; i++) {
            expect(currentResults[i].toString()).toEqual(bigInt(0).toString())
        }

        // Calculate the vote tally for a batch of state leaves
		const tally = maciState.computeBatchVoteTally(startIndex, quadVoteTallyBatchSize)
		console.log("tally: ", tally)

        expect(tally.length.toString()).toEqual((2 ** voteOptionTreeDepth).toString())
        expect(tally[voteOptionIndex].toString()).toEqual(voteWeight.toString())

        const currentResultsSalt = genRandomSalt()
        const newResultsSalt = genRandomSalt()

        // Generate circuit inputs
        const circuitInputs 
            = maciState.genQuadVoteTallyCircuitInputs(
                startIndex,
                quadVoteTallyBatchSize,
                currentResultsSalt,
                newResultsSalt,
            )

        expect(circuitInputs.stateLeaves.length).toEqual(4)

        const witness = circuit.calculateWitness(stringifyBigInts(circuitInputs))
        expect(circuit.checkWitness(witness)).toBeTruthy()
        const result = witness[circuit.getSignalIdx('main.newResultsCommitment')]
        const expectedCommitment = genTallyResultCommitment(tally, newResultsSalt)

        expect(result.toString()).toEqual(expectedCommitment.toString())
    })
})
