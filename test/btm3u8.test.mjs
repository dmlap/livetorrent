/* eslint-env mocha */
import BTM3U8 from '../bin/btm3u8.mjs'
import seghash from '../bin/seghash.mjs'
import assert from 'assert'
import { Readable } from 'stream'
import crypto from 'crypto'

const PIECE_LENGTH = seghash.PIECE_LENGTH

const minExample = [
  '#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:10,', 'index0.m4s', '#EXT-X-ENDLIST'
]

function byteStream (string) {
  return Readable.from(Buffer.from(string))
}

function shaHash (content) {
  const hash = crypto.createHash('sha1')
  hash.update(content)
  return hash.digest('hex')
}

describe('BTM3U8', () => {
  it('detects segment and map declarations', async () => {
    const lines = []
    const btm3u8 = new BTM3U8((line, next) => {
      lines.push(line)
      lines.push(next)
      return [line]
    })

    const itr = btm3u8.transform(byteStream(minExample.join('\n')))
    let result
    do {
      result = await itr.next()
    } while (!result.done)

    assert.deepStrictEqual(lines, [
      minExample[0], 'init.mp4', minExample[2], minExample[3]
    ])
  })

  it('handles lines with carriage-returns before newlines', async () => {
    const btm3u8 = new BTM3U8((line, next) => {
      return [line]
    })

    const itr = btm3u8.transform(byteStream(minExample.join('\r\n')))
    const results = []
    for await (const output of itr) {
      results.push(output)
    }
    assert.deepStrictEqual(results, minExample)
  })

  it('the current line is undefined when a segment is encountered at the beginning of input', async () => {
    let end = 'this should be replaced with `undefined`'
    const btm3u8 = new BTM3U8((line, next) => {
      end = line
      return [line]
    })

    const itr = btm3u8.transform(byteStream(minExample.slice(3).join('\n')))
    let result
    do {
      result = await itr.next()
    } while (!result.done)

    assert.strictEqual(end, undefined)
  })

  it('applies the hasher to a segment declaration and preceding line', async () => {
    const segment = []
    let count = 0
    const btm3u8 = new BTM3U8((current, next) => {
      segment.push(next)
      return ['' + count++]
    })

    const itr = btm3u8.transform(byteStream(minExample.join('\n')))
    let result = ''
    for await (const output of itr) {
      result += output + '\n'
    }

    const expected = minExample.slice()
    expected.splice(0, 1, '0')
    expected.splice(2, 1, '1')
    assert.equal(result, expected.join('\n') + '\n')
    assert.deepStrictEqual(segment, ['init.mp4', minExample[3]])
  })

  it('outputs the complete m3u8', async () => {
    const btm3u8 = new BTM3U8((line, next) => {
      return [line]
    })

    const itr = btm3u8.transform(byteStream(minExample.join('\n')))
    let result = ''
    for await (const output of itr) {
      result += output + '\n'
    }
    assert.equal(result, minExample.join('\n') + '\n')
  })

  it('allows hashers to inject new lines', async () => {
    const btm3u8 = new BTM3U8((line, next) => {
      return [line, 'injected']
    })

    const itr = btm3u8.transform(byteStream(minExample.join('\n')))
    const result = []
    for await (const output of itr) {
      result.push(output)
    }

    const expected = minExample.slice()
    expected.splice(1, 0, 'injected')
    expected.splice(4, 0, 'injected')
    assert.deepStrictEqual(result, expected)
  })

  it('buffers input when necessary for parsing', async () => {
    const btm3u8 = new BTM3U8((line, next) => {
      return [line]
    })

    async function * choppy () {
      const example = minExample.join('\r\n')
      yield Buffer.from(example.slice(0, 1)) // '#'
      yield Buffer.from(example.slice(1, 10)) // 'EXTM3U\r\n#E'
      yield Buffer.from(example.slice(10, 20)) // 'XTINF:10,\r'
      yield Buffer.from(example.slice(20))
    }

    const results = []
    for await (const output of btm3u8.transform(choppy())) {
      results.push(output)
    }
    assert.deepStrictEqual(results, minExample)
  })

  it('injects a EXT-X-BT tag before segments', async () => {
    const btTagPattern = (/^#EXT-X-BT:HASH="([0-9a-fA-F]*)",LENGTH=(\d*)$/)
    const btm3u8 = new BTM3U8()
    const segmentContent = Buffer.alloc(PIECE_LENGTH)
    const sha = shaHash(segmentContent)
    btm3u8.fetchSegment = async (url) => {
      return Readable.from(segmentContent)
    }

    const itr = btm3u8.transform(byteStream(minExample.join('\n')))
    const result = []
    for await (const output of itr) {
      result.push(output)
    }

    const [line, resultSha, resultLength] = btTagPattern.exec(result[4])
    assert(line)
    assert.strictEqual(resultSha, sha)
    assert.strictEqual(parseInt(resultLength, 10), segmentContent.byteLength)
  })

  it('injects an EXT-X-BT-MAP tag before X-MAP tags', async () => {
    const btMapTagPattern = (/^#EXT-X-BT-MAP:HASH="([0-9a-fA-F]*)",LENGTH=(\d*)$/)
    const btm3u8 = new BTM3U8()
    const segmentContent = Buffer.alloc(PIECE_LENGTH)
    const sha = shaHash(segmentContent)
    btm3u8.fetchSegment = async (url) => {
      return Readable.from(segmentContent)
    }

    const itr = btm3u8.transform(byteStream(minExample.join('\n')))
    const result = []
    for await (const output of itr) {
      result.push(output)
    }

    const [line, resultSha, resultLength] = btMapTagPattern.exec(result[1])
    assert(line)
    assert.strictEqual(resultSha, sha)
    assert.strictEqual(parseInt(resultLength, 10), segmentContent.byteLength)
  })
})
