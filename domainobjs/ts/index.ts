import * as assert from 'assert'
import {
    bigInt,
    Ciphertext,
    Plaintext,
    EcdhSharedKey,
    Signature,
    SnarkBigInt,
    PubKey as RawPubKey,
    PrivKey as RawPrivKey,
    encrypt,
    decrypt,
    sign,
    hash,
    verifySignature,
    genRandomSalt,
    genKeypair,
    genPubKey,
    formatPrivKeyForBabyJub,
    genEcdhSharedKey,
} from 'maci-crypto'

interface Keypair {
    privKey: RawPrivKey,
    pubKey: RawPubKey,
}

class Keypair implements Keypair {
    public privKey: PrivKey
    public pubKey: PubKey

    constructor (
        privKey?: PrivKey,
    ) {
        if (privKey) {
            this.privKey = privKey
            this.pubKey = new PubKey(genPubKey(privKey.rawPrivKey))
        } else {
            const rawKeyPair = genKeypair()
            this.privKey = new PrivKey(rawKeyPair.privKey)
            this.pubKey = new PubKey(rawKeyPair.pubKey)
        }
    }

    public copy = (): Keypair => {
        return new Keypair(this.privKey.copy())
    }
    
    public static genEcdhSharedKey(
        privKey: PrivKey,
        pubKey: PubKey,
    ) {
        return genEcdhSharedKey(privKey.rawPrivKey, pubKey.rawPubKey)
    }

    public equals(
        keypair: Keypair,
    ): boolean {

        const equalPrivKey = this.privKey.rawPrivKey === keypair.privKey.rawPrivKey
        const equalPubKey =
            this.pubKey.rawPubKey[0] === keypair.pubKey.rawPubKey[0] &&
            this.pubKey.rawPubKey[1] === keypair.pubKey.rawPubKey[1]

        // If this assertion fails, something is very wrong and this function
        // should not return anything 
        // XOR is equivalent to: (x && !y) || (!x && y ) 
        const x = (equalPrivKey && equalPubKey) 
        const y = (!equalPrivKey && !equalPubKey) 

        assert((x && !y) || (!x && y))

        return equalPrivKey
    }
}

class PrivKey {
    public rawPrivKey: RawPrivKey

    constructor (rawPrivKey: RawPrivKey) {
        this.rawPrivKey = rawPrivKey
    }

    public copy = (): PrivKey => {
        return new PrivKey(bigInt(this.rawPrivKey.toString()))
    }

    public asCircuitInputs = () => {
        return formatPrivKeyForBabyJub(this.rawPrivKey).toString()
    }
}

class PubKey {
    public rawPubKey: RawPubKey

    constructor (rawPubKey: RawPubKey) {
        assert(rawPubKey.length === 2)
        this.rawPubKey = rawPubKey
    }

    public copy = (): PubKey => {

        return new PubKey([
            bigInt(this.rawPubKey[0].toString()),
            bigInt(this.rawPubKey[1].toString()),
        ])
    }

    public asContractParam = () => {
        return { 
            x: this.rawPubKey[0].toString(),
            y: this.rawPubKey[1].toString(),
        }
    }

    public asCircuitInputs = () => {
        return this.rawPubKey.map((x) => x.toString())
    }

    public asArray = (): SnarkBigInt[] => {
        return [
            this.rawPubKey[0],
            this.rawPubKey[1],
        ]
    }
}

interface IStateLeaf {
    pubKey: PubKey;
    voteOptionTreeRoot: SnarkBigInt;
    voiceCreditBalance: SnarkBigInt;
    nonce: SnarkBigInt;
}

interface VoteOptionTreeLeaf {
    votes: SnarkBigInt;
}

/*
 * An encrypted command and signature.
 */
class Message {
    public iv: SnarkBigInt
    public data: SnarkBigInt[]

    constructor (
        iv: SnarkBigInt,
        data: SnarkBigInt[],
    ) {
        assert(data.length === 10)
        this.iv = iv
        this.data = data
    }

    private asArray = (): SnarkBigInt[] => {

        return [
            this.iv,
            ...this.data,
        ]
    }

    public asContractParam = () => {
        return {
            iv: this.iv.toString(),
            data: this.data.map((x: SnarkBigInt) => x.toString()),
        }
    }

    public asCircuitInputs = (): SnarkBigInt[] => {

        return this.asArray()
    }

    public hash = (): SnarkBigInt => {

        return hash(this.asArray())
    }

    public copy = (): Message => {

        return new Message(
            bigInt(this.iv.toString()),
            this.data.map((x: SnarkBigInt) => bigInt(x.toString())),
        )
    }
}

/*
 * A leaf in the state tree, which maps public keys to votes
 */
class StateLeaf implements IStateLeaf {
    public pubKey: PubKey
    public voteOptionTreeRoot: SnarkBigInt
    public voiceCreditBalance: SnarkBigInt
    public nonce: SnarkBigInt

    constructor (
        pubKey: PubKey,
        voteOptionTreeRoot: SnarkBigInt,
        voiceCreditBalance: SnarkBigInt,
        nonce: SnarkBigInt,
    ) {
        this.pubKey = pubKey
        this.voteOptionTreeRoot = voteOptionTreeRoot
        this.voiceCreditBalance = voiceCreditBalance
        // The this is the current nonce. i.e. a user who has published 0 valid
        // command should have this value at 0, and the first command should
        // have a nonce of 1
        this.nonce = nonce
    }

    public copy(): StateLeaf {
        return new StateLeaf(
            this.pubKey.copy(),
            bigInt(this.voteOptionTreeRoot.toString()),
            bigInt(this.voiceCreditBalance.toString()),
            bigInt(this.nonce.toString()),
        )
    }

    public static genBlankLeaf(
        emptyVoteOptionTreeRoot: SnarkBigInt,
    ): StateLeaf {
        return new StateLeaf(
            new PubKey([0, 0]),
            emptyVoteOptionTreeRoot,
            bigInt(0),
            bigInt(0),
        )
    }

    public static genRandomLeaf() {
        return new StateLeaf(
            new PubKey([genRandomSalt(), genRandomSalt()]),
            genRandomSalt(),
            genRandomSalt(),
            genRandomSalt(),
        )
    }

    private asArray = (): SnarkBigInt[] => {

        return [
            ...this.pubKey.asArray(),
            this.voteOptionTreeRoot,
            this.voiceCreditBalance,
            this.nonce,
        ]
    }

    public asCircuitInputs = (): SnarkBigInt[] => {

        return this.asArray()
    }

    public hash = (): SnarkBigInt => {

        return hash(this.asArray())
    }
}

interface ICommand {
    stateIndex: SnarkBigInt;
    newPubKey: PubKey;
    voteOptionIndex: SnarkBigInt;
    newVoteWeight: SnarkBigInt;
    nonce: SnarkBigInt;

    sign: (PrivKey) => Signature;
    encrypt: (EcdhSharedKey, Signature) => Message;
}

/*
 * Unencrypted data whose fields include the user's public key, vote etc.
 */
class Command implements ICommand {
    public stateIndex: SnarkBigInt
    public newPubKey: PubKey
    public voteOptionIndex: SnarkBigInt
    public newVoteWeight: SnarkBigInt
    public nonce: SnarkBigInt
    public salt: SnarkBigInt

    constructor (
        stateIndex: SnarkBigInt,
        newPubKey: PubKey,
        voteOptionIndex: SnarkBigInt,
        newVoteWeight: SnarkBigInt,
        nonce: SnarkBigInt,
        salt: SnarkBigInt = genRandomSalt(),
    ) {
        this.stateIndex = stateIndex
        this.newPubKey = newPubKey
        this.voteOptionIndex = voteOptionIndex
        this.newVoteWeight = newVoteWeight
        this.nonce = nonce
        this.salt = salt
    }

    public copy = (): Command => {

        return new Command(
            bigInt(this.stateIndex.toString()),
            this.newPubKey.copy(),
            bigInt(this.voteOptionIndex.toString()),
            bigInt(this.newVoteWeight.toString()),
            bigInt(this.nonce.toString()),
            bigInt(this.salt.toString()),
        )
    }

    public asArray = (): SnarkBigInt[] => {

        return [
            this.stateIndex,
            ...this.newPubKey.asArray(),
            this.voteOptionIndex,
            this.newVoteWeight,
            this.nonce,
            this.salt,
        ]
    }

    /*
     * Check whether this command has deep equivalence to another command
     */
    public equals = (command: Command): boolean => {

        return this.stateIndex == command.stateIndex &&
            this.newPubKey[0] == command.newPubKey[0] &&
            this.newPubKey[1] == command.newPubKey[1] &&
            this.voteOptionIndex == command.voteOptionIndex &&
            this.newVoteWeight == command.newVoteWeight &&
            this.nonce == command.nonce &&
            this.salt == command.salt
    }

    /*
     * Signs this command and returns a Signature.
     */
    public sign = (
        privKey: PrivKey,
    ): Signature => {

        return sign(privKey.rawPrivKey, hash(this.asArray()))
    }

    /*
     * Returns true if the given signature is a correct signature of this
     * command and signed by the private key associated with the given public
     * key.
     */
    public verifySignature = (
        signature: Signature,
        pubKey: PubKey,
    ): boolean => {

        return verifySignature(
            hash(this.asArray()),
            signature,
            pubKey.rawPubKey,
        )
    }

    /*
     * Encrypts this command along with a signature to produce a Message.
     */
    public encrypt = (
        signature: Signature,
        sharedKey: EcdhSharedKey,
    ): Message => {

        const plaintext: Plaintext = [
            ...this.asArray(),
            signature.R8[0],
            signature.R8[1],
            signature.S,
        ]

        const ciphertext: Ciphertext = encrypt(plaintext, sharedKey)
        const message = new Message(ciphertext.iv, ciphertext.data)
        
        return message
    }

    /*
     * Decrypts a Message to produce a Command.
     */
    public static decrypt = (
        message: Message,
        sharedKey: EcdhSharedKey,
    ) => {

        const decrypted = decrypt(message, sharedKey)

        const command = new Command(
            decrypted[0],
            new PubKey([decrypted[1], decrypted[2]]),
            decrypted[3],
            decrypted[4],
            decrypted[5],
            decrypted[6],
        )

        const signature = {
            R8: [decrypted[7], decrypted[8]],
            S: decrypted[9],
        }

        return { command, signature }
    }
}

export {
    StateLeaf,
    VoteOptionTreeLeaf,
    Command,
    Message,
    Keypair,
    PubKey,
    PrivKey,
}
