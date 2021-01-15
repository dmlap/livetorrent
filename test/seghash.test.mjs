/* globals it */
import seghash from './../bin/seghash.mjs'
import crypto from 'crypto'
import { Readable } from 'stream'
import assert from 'assert'

function bufferStream (buffer, count = 1) {
  const stream = new Readable()
  stream._read = () => {
    for (let i = 0; i < count; i++) {
      stream.push(buffer)
    }
    stream.push(null)
  }
  return stream
}

it('calculates the sha1 and length of its input', async () => {
  const segment = Buffer.alloc(seghash.PIECE_LENGTH, 1)
  const actual = await seghash(bufferStream(segment))

  const hash = crypto.createHash('sha1')
  hash.update(segment)
  assert.equal(actual.hash.toString('hex'), hash.digest('hex'), 'sha-1 matches crypto.hash')
  assert.equal(actual.length, seghash.PIECE_LENGTH, 'length is summed up')
})

it('zero pads small segments', async () => {
  const dataLength = seghash.PIECE_LENGTH - 10
  const segment = Buffer.alloc(seghash.PIECE_LENGTH, 2)
  segment.fill(0, dataLength)
  const actual = await seghash(bufferStream(segment.subarray(0, dataLength)))

  const hash = crypto.createHash('sha1')
  hash.update(segment)
  assert.equal(actual.hash.toString('hex'), hash.digest('hex'), 'sha1 matches crypto.hash')
  assert.equal(actual.length, dataLength, 'length is summed up')
})

it('concatenates hashes for large segments', async () => {
  const count = 3
  const segment = Buffer.alloc(seghash.PIECE_LENGTH, 3)
  const actual = await seghash(bufferStream(segment, count))

  const hash = crypto.createHash('sha1')
  hash.update(segment)
  const expected = hash.digest('hex')

  assert.equal(actual.hash.toString('hex'), `${expected}${expected}${expected}`, 'sha1 matches crypto.hash')
  assert.equal(actual.length, seghash.PIECE_LENGTH * 3)
})

it('zero-pads the final piece of a large segment when necessary', async () => {
  const segment = Buffer.alloc(seghash.PIECE_LENGTH - 1, 11)
  const actual = await seghash(bufferStream(segment, 3))

  let expected = ''
  let hash = crypto.createHash('sha1')
  // first piece
  hash.update(Buffer.concat([segment, segment], seghash.PIECE_LENGTH))
  expected += hash.digest('hex')
  // second piece
  hash = crypto.createHash('sha1')
  hash.update(Buffer.concat([
    segment.subarray(1),
    segment
  ], seghash.PIECE_LENGTH))
  expected += hash.digest('hex')
  // final piece
  hash = crypto.createHash('sha1')
  hash.update(Buffer.concat([
    segment.subarray(2),
    Buffer.alloc(3)
  ]))
  expected += hash.digest('hex')

  assert.equal(actual.hash.toString('hex'), expected, 'sha1 matches crypto.hash')
  assert.equal(actual.length, 3 * segment.byteLength, 'length is summed up')
})
