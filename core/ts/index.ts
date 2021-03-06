import * as assert from 'assert'
import {
    PrivKey,
    PubKey,
    Command,
    Message,
    Keypair,
    StateLeaf,
} from 'maci-domainobjs'

import {
    hash,
    bigInt,
    SnarkBigInt,
    genRandomSalt,
    stringifyBigInts,
    NOTHING_UP_MY_SLEEVE,
    IncrementalMerkleTree,
} from 'maci-crypto'

class User {
    public pubKey: PubKey
    public votes: SnarkBigInt[]
    public voiceCreditBalance: SnarkBigInt

    // The this is the current nonce. i.e. a user who has published 0 valid
    // command should have this value at 0, and the first command should
    // have a nonce of 1
    public nonce: SnarkBigInt

    constructor(
        _pubKey: PubKey,
        _votes: SnarkBigInt[],
        _voiceCreditBalance: SnarkBigInt,
        _nonce: SnarkBigInt,
    ) {
        this.pubKey = _pubKey
        this.votes = _votes.map(bigInt)
        this.voiceCreditBalance = bigInt(_voiceCreditBalance)
        this.nonce = bigInt(_nonce)
    }

    /*
     * Return a deep copy of this User
     */
    public copy = (): User => {
        let newVotesArr: SnarkBigInt[] = []
        for (let i = 0; i < this.votes.length; i++) {
            newVotesArr.push(bigInt(this.votes[i].toString()))
        }

        return new User(
            this.pubKey.copy(),
            newVotesArr,
            bigInt(this.voiceCreditBalance.toString()),
            bigInt(this.nonce.toString()),
        )
    }

    /*
     * Convert this User into a StateLeaf
     */
    public genStateLeaf = (
        _voteOptionTreeDepth: number,
    ): StateLeaf => {
        const voteOptionTree = new IncrementalMerkleTree(
            _voteOptionTreeDepth,
            bigInt(0),
        )

        for (let vote of this.votes) {
            voteOptionTree.insert(vote)
        }

        return new StateLeaf(
            this.pubKey,
            voteOptionTree.root,
            this.voiceCreditBalance,
            this.nonce,
        )
    }
}

class MaciState {
    public coordinatorKeypair: Keypair
    public users: User[] = []
    public stateTreeDepth: SnarkBigInt
    public messageTreeDepth: SnarkBigInt
    public voteOptionTreeDepth: SnarkBigInt
    public messages: Message[] = []
    public zerothStateLeaf: StateLeaf
    public maxVoteOptionIndex: SnarkBigInt
    public encPubKeys: PubKey[] = []
    private emptyVoteOptionTreeRoot

    // encPubKeys contains the public keys used to generate ephemeral shared
    // keys which encrypt each message

    constructor(
        _coordinatorKeypair: Keypair,
        _stateTreeDepth: SnarkBigInt,
        _messageTreeDepth: SnarkBigInt,
        _voteOptionTreeDepth: SnarkBigInt,
        _maxVoteOptionIndex: SnarkBigInt,
    ) {

        this.coordinatorKeypair = _coordinatorKeypair
        this.stateTreeDepth = bigInt(_stateTreeDepth)
        this.messageTreeDepth = bigInt(_messageTreeDepth)
        this.voteOptionTreeDepth = bigInt(_voteOptionTreeDepth)
        this.maxVoteOptionIndex = bigInt(_maxVoteOptionIndex)

        const emptyVoteOptionTree = new IncrementalMerkleTree(
            this.voteOptionTreeDepth,
            bigInt(0),
        )
        this.emptyVoteOptionTreeRoot = emptyVoteOptionTree.root

        this.zerothStateLeaf 
            = StateLeaf.genBlankLeaf(this.emptyVoteOptionTreeRoot)
    }

    /*
     * Return an array of zeroes (0) of length voteOptionTreeDepth
     */
    private genBlankVotes = () => {
        let votes: SnarkBigInt[] = []
        for (let i = 0; i < bigInt(2).pow(this.voteOptionTreeDepth); i ++) {
            votes.push(bigInt(0))
        }

        return votes
    }

    /*
     * Return an IncrementalMerkleTree where the zeroth leaf is
     * this.zerothStateLeaf and the other leaves are the Users as hashed
     * StateLeaf objects
     */
    public genStateTree = (): IncrementalMerkleTree => {
        const blankStateLeaf = StateLeaf.genBlankLeaf(
            this.emptyVoteOptionTreeRoot,
        )

        const stateTree = new IncrementalMerkleTree(
            this.stateTreeDepth,
            blankStateLeaf.hash(),
        )

        stateTree.insert(this.zerothStateLeaf.hash())
        for (let user of this.users) {
            const stateLeaf = user.genStateLeaf(this.voteOptionTreeDepth)
            stateTree.insert(stateLeaf.hash())
        }
        return stateTree
    }

    /*
     * Computes the state root
     */
    public genStateRoot = (): SnarkBigInt => {
        return this.genStateTree().root
    }

    public genMessageTree = (): IncrementalMerkleTree => {
        const messageTree = new IncrementalMerkleTree(
            this.messageTreeDepth,
            NOTHING_UP_MY_SLEEVE,
        )

        for (let message of this.messages) {
            messageTree.insert(message.hash())
        }

        return messageTree
    }

    public genMessageRoot = (): SnarkBigInt => {
        return this.genMessageTree().root
    }

    /*
     * Deep-copy this object
     */
    public copy = (): MaciState => {
        const copied = new MaciState(
            this.coordinatorKeypair.copy(),
            bigInt(this.stateTreeDepth.toString()),
            bigInt(this.messageTreeDepth.toString()),
            bigInt(this.voteOptionTreeDepth.toString()),
            bigInt(this.maxVoteOptionIndex.toString()),
        )

        copied.users = this.users.map((x: User) => x.copy())
        copied.messages = this.messages.map((x: Message) => x.copy())
        copied.encPubKeys = this.encPubKeys.map((x: PubKey) => x.copy())

        return copied
    }

    /*
     * Add a new user to the list of users.
     */
    public signUp = (
        _pubKey: PubKey,
        _initialVoiceCreditBalance: SnarkBigInt,
    ) => {

        // Note that we do not insert a state leaf to any state tree here. This
        // is because we want to keep the state minimal, and only compute what
        // is necessary when it is needed. This may change if we run into
        // severe performance issues, but it is currently worth the tradeoff.
        this.users.push(
            new User(
                _pubKey,
                this.genBlankVotes(),
                _initialVoiceCreditBalance,
                bigInt(0),
            )
        )
    }

    /*
     * Inserts a Message into the list of messages, as well as the
     * corresponding public key used to generate the ECDH shared key which was
     * used to encrypt said message.
     */
    public publishMessage = (
        _message: Message,
        _encPubKey: PubKey,
    ) => {

        this.encPubKeys.push(_encPubKey)
        this.messages.push(_message)
    }

    /*
     * Process the message at index 0 of the message array. Note that this is
     * not the state leaf index, as leaf 0 of the state tree is a random value.
     */
    public processMessage = (
        _index: number,
    ) => {

        const message = this.messages[_index]
        const encPubKey = this.encPubKeys[_index]

        const sharedKey = Keypair.genEcdhSharedKey(this.coordinatorKeypair.privKey, encPubKey)
        const { command, signature } = Command.decrypt(message, sharedKey)

        // If the state tree index in the command is invalid, do nothing
        if (command.stateIndex > this.users.length) {
            return 
        }

        const userIndex = command.stateIndex - bigInt(1)
        const user = this.users[userIndex]

        // If the signature is invalid, do nothing
        if (! command.verifySignature(signature, user.pubKey)) {
            return
        }

        // If the nonce is invalid, do nothing
        if (command.nonce !== user.nonce + bigInt(1)) {
            return
        }

        // If there are insufficient vote credits, do nothing
        const prevSpentCred = user.votes[command.voteOptionIndex]

        const voiceCreditsLeft = 
            user.voiceCreditBalance + 
            (prevSpentCred * prevSpentCred) -
            (command.newVoteWeight * command.newVoteWeight)

        if (voiceCreditsLeft < 0) {
            return
        }

        // If the vote option index is invalid, do nothing
        if (command.voteOptionIndex > this.maxVoteOptionIndex) {
            return
        }

        // Update the user's vote option tree, pubkey, voice credit balance,
        // and nonce
        let newVotesArr: SnarkBigInt[] = []
        for (let i = 0; i < this.users.length; i++) {
            if (i === command.voteOptionIndex) {
                newVotesArr.push(command.newVoteWeight)
            } else {
                newVotesArr.push(bigInt(user.votes[i].toString()))
            }
        }

        const newUser = user.copy()
        newUser.nonce = newUser.nonce + bigInt(1)
        newUser.votes[command.voteOptionIndex] = command.newVoteWeight
        newUser.voiceCreditBalance = voiceCreditsLeft

        this.users[userIndex] = newUser
    }

    /*
     * Process _batchSize messages starting from _index, and then update
     * zerothStateLeaf.
     */
    public batchProcessMessage = (
        _index: number,
        _batchSize: number,
        _randomStateLeaf: StateLeaf,
    ) => {
        for (let i = 0; i < _batchSize; i++) {
            const messageIndex: number = _index + i;
            this.processMessage(messageIndex)
        }
        this.zerothStateLeaf = _randomStateLeaf
    }

    /*
     * Generates inputs to the UpdateStateTree circuit. Do not call
     * processMessage() or batchProcessMessage() before this function.
     */
    public genUpdateStateTreeCircuitInputs = (
        _index: number,
    ) => {
        const message = this.messages[_index]
        const encPubKey = this.encPubKeys[_index]
        const sharedKey = Keypair.genEcdhSharedKey(
            this.coordinatorKeypair.privKey,
            encPubKey,
        )
        const { command, signature } = Command.decrypt(message, sharedKey)

        const messageTree = this.genMessageTree()
        const [ msgTreePathElements, msgTreePathIndices ]
            = messageTree.getPathUpdate(_index)

        const stateTree = this.genStateTree()
        const stateTreeMaxIndex = bigInt(stateTree.nextIndex) - bigInt(1)

        const user = this.users[bigInt(command.stateIndex) - bigInt(1)]

        const currentVoteWeight = user.votes[command.voteOptionIndex]

        const voteOptionTree = new IncrementalMerkleTree(
            this.voteOptionTreeDepth,
            bigInt(0),
        )
        for (let vote of user.votes) {
            voteOptionTree.insert(vote)
        }

        const [ voteOptionTreePathElements, voteOptionTreeIndices ]
            = voteOptionTree.getPathUpdate(command.voteOptionIndex)

        const stateLeaf = user.genStateLeaf(this.voteOptionTreeDepth)
        const [ stateTreePathElements, stateTreePathIndices ]
            = stateTree.getPathUpdate(command.stateIndex)

        return stringifyBigInts({
            'coordinator_public_key': this.coordinatorKeypair.pubKey.asCircuitInputs(),
            'ecdh_private_key': this.coordinatorKeypair.privKey.asCircuitInputs(),
            'ecdh_public_key': encPubKey.asCircuitInputs(),
            'message': message.asCircuitInputs(),
            'msg_tree_root': messageTree.root,
            'msg_tree_path_elements': msgTreePathElements,
            'msg_tree_path_index': msgTreePathIndices,
            'vote_options_leaf_raw': currentVoteWeight,
            'vote_options_tree_root': voteOptionTree.root,
            'vote_options_tree_path_elements': voteOptionTreePathElements,
            'vote_options_tree_path_index': voteOptionTreeIndices,
            'vote_options_max_leaf_index': this.maxVoteOptionIndex,
            'state_tree_data_raw': stateLeaf.asCircuitInputs(),
            'state_tree_max_leaf_index': stateTreeMaxIndex,
            'state_tree_root': stateTree.root,
            'state_tree_path_elements': stateTreePathElements,
            'state_tree_path_index': stateTreePathIndices,
        })
    }

    /*
     * Generates inputs to the BatchUpdateStateTree circuit. Do not call
     * processMessage() or batchProcessMessage() before this function.
     */
    public genBatchUpdateStateTreeCircuitInputs = (
        _index: number,
        _batchSize: number,
        _randomStateLeaf: StateLeaf,
    ) => {

        let stateLeaves: StateLeaf[] = []
        let stateRoots: SnarkBigInt[] = []
        let stateTreePathElements: SnarkBigInt[][] = []
        let stateTreePathIndices: SnarkBigInt[][] = []
        let voteOptionLeaves: SnarkBigInt[] = []
        let voteOptionTreeRoots: SnarkBigInt[] = []
        let voteOptionTreePathElements: SnarkBigInt[][] = []
        let voteOptionTreePathIndices: SnarkBigInt[][] = []
        let messageTreePathElements: any[] = []

        let clonedMaciState = this.copy()
        const messageTree = clonedMaciState.genMessageTree()

        for (let i = 0; i < _batchSize; i ++) {
            const messageIndex: number = _index + i;

            // Generate circuit inputs for the current message
            const ustCircuitInputs 
                = clonedMaciState.genUpdateStateTreeCircuitInputs(messageIndex)

            messageTreePathElements.push(ustCircuitInputs.msg_tree_path_elements)
            stateRoots.push(ustCircuitInputs.state_tree_root)
            stateTreePathElements.push(ustCircuitInputs.state_tree_path_elements)
            stateTreePathIndices.push(ustCircuitInputs.state_tree_path_index)
            voteOptionLeaves.push(ustCircuitInputs.vote_options_leaf_raw)
            stateLeaves.push(ustCircuitInputs.state_tree_data_raw)
            voteOptionTreeRoots.push(ustCircuitInputs.vote_options_tree_root)
            voteOptionTreePathElements.push(ustCircuitInputs.vote_options_tree_path_elements)
            voteOptionTreePathIndices.push(ustCircuitInputs.vote_options_tree_path_index)

            // Process the message
            clonedMaciState.processMessage(messageIndex)
        }

        const stateTree = clonedMaciState.genStateTree()

        const randomLeafRoot = stateTree.root

        // Insert the random leaf
        stateTree.update(0, _randomStateLeaf.hash())

        const [randomStateLeafPathElements, _] = stateTree.getPathUpdate(0)

        return stringifyBigInts({
            'coordinator_public_key': clonedMaciState.coordinatorKeypair.pubKey.asCircuitInputs(),
            'message': clonedMaciState.messages.map((x) => x.asCircuitInputs()),
            'ecdh_private_key': clonedMaciState.coordinatorKeypair.privKey.asCircuitInputs(),
            'ecdh_public_key': clonedMaciState.encPubKeys.map((x) => x.asCircuitInputs()),
            'msg_tree_root': messageTree.root,
            'msg_tree_path_elements': messageTreePathElements,
            'msg_tree_batch_start_index': _index,
            'random_leaf': _randomStateLeaf.hash(),
            'state_tree_root': stateRoots,
            'state_tree_path_elements': stateTreePathElements,
            'state_tree_path_index': stateTreePathIndices,
            'random_leaf_root': randomLeafRoot,
            'random_leaf_path_elements': randomStateLeafPathElements,
            'vote_options_leaf_raw': voteOptionLeaves,
            'state_tree_data_raw': stateLeaves,
            'state_tree_max_leaf_index': bigInt(stateTree.nextIndex - 1),
            'vote_options_max_leaf_index': clonedMaciState.maxVoteOptionIndex,
            'vote_options_tree_root': voteOptionTreeRoots,
            'vote_options_tree_path_elements': voteOptionTreePathElements,
            'vote_options_tree_path_index': voteOptionTreePathIndices,
        })
    }

    /*
     * Compute the vote tally up to the specified state tree index. Ignores the
     * zeroth state leaf.
     * @param _startIndex The state tree index. Only leaves before this index
     *                    are included in the tally.
     */ 
    public computeCumulativeVoteTally = (
        _startIndex: SnarkBigInt,
    ): SnarkBigInt[] => {
        assert(bigInt(this.users.length) > _startIndex)

        // results should start off with 0s
        let results: SnarkBigInt[] = []
        for (let i = 0; i < bigInt(2).pow(this.voteOptionTreeDepth); i ++) {
            results.push(bigInt(0))
        }

        // Compute the cumulative total up till startIndex - 1 (since we should
        // ignore the 0th leaf)
        for (let i = bigInt(0); i < bigInt(_startIndex) - bigInt(1); i++) {
            const user = this.users[i]
            for (let j = 0; j < user.votes.length; j ++) {
                results[j] += user.votes[j]
            }
        }

        return results
    }

    /*
     * Tallies the votes for a batch of users. This does not perform a
     * cumulative tally. This works as long as the _startIndex is lower than
     * the total number of users. e.g. if _batchSize is 4, there are 10 users,
     * and _startIndex is 8, this function will tally the votes from the last 2
     * users.
     * @param _startIndex The index of the first user in the batch
     * @param _batchSize The number of users to tally.
     */
    public computeBatchVoteTally = (
        _startIndex: SnarkBigInt,
        _batchSize: SnarkBigInt,
    ): SnarkBigInt[] => {

        // Check whether _startIndex is within range.
        assert(_startIndex >= 0 && _startIndex < this.users.length)

        // Check whether _startIndex is a multiple of _batchSize
        assert(bigInt(_startIndex) % bigInt(_batchSize) === bigInt(0))

        // Fill results with 0s
        let results: SnarkBigInt[] = []
        for (let i = 0; i < bigInt(2).pow(this.voteOptionTreeDepth); i++) {
            results.push(bigInt(0))
        }

        // Compute the tally
        if (_startIndex === 0) {
            _batchSize = _batchSize - bigInt(1)
            _startIndex = bigInt(1)
        }

        for (let i = 0; i < _batchSize; i ++) {
            const userIndex = bigInt(_startIndex) + bigInt(i)
            if (userIndex < this.users.length) {
                const votes = this.users[userIndex].votes
                for (let j = 0; j < votes.length; j++) {
                    results[j] += votes[j]
                }
            } else {
                break
            }
        }

        return results
    }

    /*
     * Generates circuit inputs to the QuadVoteTally function.
     * @param _startIndex The index of the first state leaf in the tree
     * @param _batchSize The number of leaves per batch of state leaves
     * @param _currentResultsSalt The salt for the cumulative vote tally
     * @param _newResultsSalt The salt for the new vote tally
     */
    public genQuadVoteTallyCircuitInputs = (
        _startIndex: SnarkBigInt,
        _batchSize: SnarkBigInt,
        _currentResultsSalt: SnarkBigInt,
        _newResultsSalt: SnarkBigInt,
    ) => {
        _startIndex = bigInt(_startIndex)
        _batchSize = bigInt(_batchSize)

        const currentResults = this.computeCumulativeVoteTally(_startIndex)
        const batchResults = this.computeBatchVoteTally(_startIndex, _batchSize)

        assert(currentResults.length === batchResults.length)

        let newResults: SnarkBigInt[] = []
        for (let i = 0; i < currentResults.length; i++) {
            newResults[i] = currentResults[i] + batchResults[i]
        }

        const currentResultsCommitment = hash([
            ...currentResults,
            _currentResultsSalt
        ])

        const blankStateLeaf = StateLeaf.genBlankLeaf(
            this.emptyVoteOptionTreeRoot,
        )

        const blankStateLeafHash = blankStateLeaf.hash()
        const batchTreeDepth = bigInt(Math.sqrt(_batchSize.toString()))

        let stateLeaves: StateLeaf[] = []
        let voteLeaves: StateLeaf[][] = []

        if (_startIndex === bigInt(0)) {
            stateLeaves.push(this.zerothStateLeaf)
            voteLeaves.push(this.genBlankVotes())
        }

        for (let i = bigInt(0); i < _batchSize; i++) {
            debugger
            if (_startIndex === bigInt(0) && i === bigInt(0)) {
                continue
            }

            const userIndex = _startIndex + i - bigInt(1)
            if (userIndex < this.users.length) {
                stateLeaves.push(
                    this.users[userIndex]
                        .genStateLeaf(this.voteOptionTreeDepth)
                )
                voteLeaves.push(this.users[userIndex].votes)
            } else {
                stateLeaves.push(blankStateLeaf)
                voteLeaves.push(this.genBlankVotes())
            }
        }

        // We need to generate the following in order to create the
        // intermediate tree path:
        // 1. The tree whose leaves are the state leaves are the roots of
        //    subtrees (the intermediate tree)
        // 2. Each batch tree whose leaves are state leaves

        const emptyBatchTree = new IncrementalMerkleTree(
            batchTreeDepth,
            blankStateLeafHash,
        )

        const intermediateTree = new IncrementalMerkleTree(
            this.stateTreeDepth - batchTreeDepth,
            emptyBatchTree.root,
        )

        // For each batch, create a tree of the leaves in the batch, and insert the
        // tree root into the intermediate tree
        for (let i = bigInt(0); i < bigInt(2).pow(this.stateTreeDepth); i += _batchSize) {

            // Use this batchTree to accumulate the leaves in the batch
            const batchTree = emptyBatchTree.copy()

            for (let j = bigInt(0); j < _batchSize; j ++) {
                if (i === bigInt(0) && j === bigInt(0)) {
                    batchTree.insert(this.zerothStateLeaf.hash())
                } else {
                    const userIndex = i + j - bigInt(1)
                    if (userIndex < this.users.length) {
                        const leaf = this.users[userIndex]
                            .genStateLeaf(this.voteOptionTreeDepth).hash()
                        batchTree.insert(leaf)
                    }
                }
            }

            // Insert the root of the batch tree
            intermediateTree.insert(batchTree.root)
        }

        assert(intermediateTree.root === this.genStateRoot())

        const intermediatePathIndex = _startIndex / _batchSize
        const intermediateStateRoot = intermediateTree.leaves[_startIndex / _batchSize]
        const [intermediatePathElements, _] 
            = intermediateTree.getPathUpdate(intermediatePathIndex)

        const circuitInputs = stringifyBigInts({
            voteLeaves,
            stateLeaves: stateLeaves.map((x) => x.asCircuitInputs()),
            currentResults,
            fullStateRoot: this.genStateTree().root,
            currentResultsSalt: _currentResultsSalt,
            newResultsSalt: _newResultsSalt,
            currentResultsCommitment,
            intermediatePathElements,
            intermediatePathIndex,
            intermediateStateRoot,
        })

        return circuitInputs
    }
}

/*
 * A helper function which hashes a list of results with a salt and returns the
 * hash.
 *
 * @param results A list of vote weights
 * @parm salt A random salt
 * @return The hash of the results and the salt, with the salt last
 */
const genTallyResultCommitment = (
    results: SnarkBigInt[],
    salt: SnarkBigInt,
): SnarkBigInt => {

    return hash([...results, salt])

}

export {
    genTallyResultCommitment,
    MaciState,
    User,
}
