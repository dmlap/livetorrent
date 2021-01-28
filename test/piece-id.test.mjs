/* eslint-env mocha */
/* eslint-disable no-new */
import PieceId from '../src/piece-id.mjs'
import assert from 'assert'

describe('PieceId', () => {
  it('stores a variant, segment, and piece numbers', () => {
    const variant = 1
    const segment = 2
    const piece = 3
    const id = new PieceId(variant, segment, piece)

    assert.equal(id.variant, variant)
    assert.equal(id.segment, segment)
    assert.equal(id.piece, piece)
  })

  it('is reversible', () => {
    let id = new PieceId(3, 2, 1)
    let reversed = PieceId.from(id.valueOf())

    assert.equal(id.variant, reversed.variant, 'variant is preserved')
    assert.equal(id.segment, reversed.segment, 'segment is preserved')
    assert.equal(id.piece, reversed.piece, 'piece is preserved')

    id = new PieceId(Math.pow(2, 8) - 1, Math.pow(2, 32) - 1, Math.pow(2, 12) - 1)
    reversed = PieceId.from(id.valueOf())

    assert.equal(id.variant, reversed.variant, 'max variant is preserved')
    assert.equal(id.segment, reversed.segment, 'max segment is preserved')
    assert.equal(id.piece, reversed.piece, 'max piece is preserved')

    id = new PieceId(0, 0, 0)
    reversed = PieceId.from(id.valueOf())

    assert.equal(id.variant, reversed.variant, 'zero variant is preserved')
    assert.equal(id.segment, reversed.segment, 'zero segment is preserved')
    assert.equal(id.piece, reversed.piece, 'zero piece is preserved')
  })

  it('throws on negative values', () => {
    let thrown = null
    try {
      new PieceId(-3, 2, 1)
    } catch (error) {
      thrown = error
    }
    assert(thrown, 'rejects negative variant')

    thrown = null
    try {
      new PieceId(3, -2, 1)
    } catch (error) {
      thrown = error
    }
    assert(thrown, 'rejects negative segment')

    thrown = null
    try {
      new PieceId(3, 2, -1)
    } catch (error) {
      thrown = error
    }
    assert(thrown, 'rejects negative piece')
  })

  it('throws on non-integer values', () => {
    let thrown = null
    try {
      new PieceId(1.5, 2, 1)
    } catch (error) {
      thrown = error
    }
    assert(thrown, 'rejects non-integer variant')

    thrown = null
    try {
      new PieceId(3, 2.5, 1)
    } catch (error) {
      thrown = error
    }
    assert(thrown, 'rejects non-integer segment')

    thrown = null
    try {
      new PieceId(3, 2, 0.5)
    } catch (error) {
      thrown = error
    }
    assert(thrown, 'rejects non-integer piece')

    thrown = null
    try {
      new PieceId(Math.pow(2, 8), 0, 0)
    } catch (error) {
      thrown = error
    }
    assert(thrown, 'rejects out-of-range variant')

    thrown = null
    try {
      new PieceId(0, Math.pow(2, 32), 0)
    } catch (error) {
      thrown = error
    }
    assert(thrown, 'rejects out-of-range segment')
    thrown = null
    try {
      new PieceId(0, 0, Math.pow(2, 12))
    } catch (error) {
      thrown = error
    }
    assert(thrown, 'rejects out-of-range piece')
  })
})
