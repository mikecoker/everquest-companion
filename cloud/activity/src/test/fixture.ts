import type { CloudSyncState } from '../../../../src/shared/cloudSync'

export const liveState: CloudSyncState = {
  publishedAt: 1_800_000,
  character: { id: 'primitive-freeport', name: 'Primitive', server: 'Freeport', level: 44, classes: ['Monk', 'Shaman'], zone: 'The Overthere' },
  combat: {
    inCombat: true, target: 'A fierce cockatrice', startedAt: 1_790_000, totalDamage: 12_450, dps: 622.5,
    rows: [{ name: '<script>alert(1)</script>', total: 8_000, dps: 400, kind: 'self' }, { name: 'Faithful pet', total: 4_450, dps: 222.5, kind: 'pet' }]
  },
  progression: { level: 44, percent: 67.5, xpPerHour: 12.4, etaMs: 9_435_000 },
  recent: { kills: [{ name: 'A stoneleer', ts: 1_790_000 }], loot: [{ item: 'Cockatrice beak', ts: 1_795_000, quantity: 2 }] }
}
