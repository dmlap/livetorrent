/**
 * Utility class for manipulating Live Torrent piece ids. On the wire,
 * a piece id is:
 * - 1 reserved bit
 * - 8 bits of stream identifier
 * - 32 bits of media segment number
 * - 12 bits of piece number
 */
const MAX_VARIANT = Math.pow(2, 8) - 1
const MAX_SEGMENT = Math.pow(2, 32) - 1
const MAX_PIECE = Math.pow(2, 12) - 1
const MAX_32 = Math.pow(2, 32)

function checkBounds (variant, segment, piece) {
  if (variant < 0 || segment < 0 || piece < 0 ||
      !Number.isInteger(variant) ||
      !Number.isInteger(segment) ||
      !Number.isInteger(piece)) {
    throw new RangeError(
      `Variant, segment, and piece (${variant}, ${segment}, ${piece}) must ` +
        'be non-negative integers'
    )
  }
  if (variant > MAX_VARIANT || segment > MAX_SEGMENT || piece > MAX_PIECE) {
    throw new RangeError(
      `PieceId field out of range: (${variant}, ${segment}, ${piece})`
    )
  }
}

export default class PieceId {
  constructor (variant, segment, piece) {
    checkBounds(variant, segment, piece)

    this.variant = variant
    this.segment = segment
    this.piece = piece
  }

  valueOf () {
    return PieceId.toNumber(this.variant, this.segment, this.piece)
  }
}

PieceId.toNumber = function toNumber (variant, segment, piece) {
  const high = variant << 12 | segment >>> 20
  // `>>> 0` converts the result to an unsigned 32-bit int
  const low = (segment << 12 | piece) >>> 0

  return high * MAX_32 + low
}

PieceId.from = function from (number) {
  const high = Math.floor(number / MAX_32)

  const variant = (high >>> 12) & 0xff
  // `>>> 0` converts the result to an unsigned 32-bit int
  const segment = (((high & 0xfff) << 20) | (number >>> 12)) >>> 0
  const piece = number & 0xfff

  return new PieceId(variant, segment, piece)
}
