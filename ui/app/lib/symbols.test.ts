import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildApiSymbolPath, buildSymbolDetailPath, buildSymbolId } from './symbols'

test('buildSymbolId joins broker and ticker', () => {
  assert.equal(buildSymbolId('bitflyer', 'BTC_JPY'), 'bitflyer:BTC_JPY')
})

test('buildSymbolDetailPath encodes symbol ids containing colons', () => {
  assert.equal(buildSymbolDetailPath('saxo:FX:NAS100'), '/symbols/saxo%3AFX%3ANAS100')
})

test('buildApiSymbolPath encodes symbol ids containing colons', () => {
  assert.equal(buildApiSymbolPath('saxo:FX:NAS100'), '/api/symbols/saxo%3AFX%3ANAS100')
})
