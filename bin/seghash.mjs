import crypto from 'crypto'

const PIECE_LENGTH = Math.pow(2, 18)
export default async function seghash (stream) {
  let hash = ''
  let sha = crypto.createHash('sha1')
  let length = 0
  let pieceRemaining = PIECE_LENGTH

  for await (const chunk of stream) {
    let chunkRemaining = chunk.byteLength
    let slice = chunk
    do {
      // split and write
      const writeLength = Math.min(slice.byteLength, pieceRemaining)
      sha.write(slice.subarray(0, writeLength))
      slice = slice.subarray(writeLength)
      pieceRemaining -= writeLength
      chunkRemaining -= writeLength
      if (pieceRemaining === 0) {
        // flush
        sha.end()
        hash += sha.read().toString('hex')
        sha = crypto.createHash('sha1')
        pieceRemaining = PIECE_LENGTH
      }
    } while (chunkRemaining !== 0)

    length += chunk.byteLength
  }
  if (pieceRemaining !== 0 && pieceRemaining !== PIECE_LENGTH) {
    // pad and flush
    sha.write(Buffer.alloc(pieceRemaining, 0))
    sha.end()
    hash += sha.read().toString('hex')
  }

  return { hash, length }
}
seghash.PIECE_LENGTH = PIECE_LENGTH

/*
empty, fits:     ---           ?    write,    X     X   update ix -> pad-flush
fits:              ----        ?    write,    X     X   update ix -> pad-flush
empty, full:     --------      ?    write, flush    X      ?      ->    X
full:               -----      ?    write, flush    X      ?      ->    X
empty, overflow: ----------- split, write, flush, loop, update ix -> pad-flush
overflow:              ----  split, write, flush, loop, update ix -> pad-flush
PIECE           |--------|
*/
