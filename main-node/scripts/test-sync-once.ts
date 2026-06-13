/**
 * Headless sync test — run without Electron UI.
 * Usage: npx tsx scripts/test-sync-once.ts
 */
import { runMigrations } from '../src/main/db/migrate'
import { config } from '../src/main/config'
import { nodeStateRepository } from '../src/main/repositories/nodeStateRepository'
import { seedLocalPrintersIfEmpty } from '../src/main/bootstrap/seedPrinters'
import { menuSyncService } from '../src/main/services/menuSyncService'
import { syncPullService } from '../src/main/services/syncPullService'
import { printService } from '../src/main/services/printService'
import { cloudClient } from '../src/main/services/cloudClient'

async function main() {
  console.log('Config:', {
    cloud: config.cloudBaseUrl,
    location: config.locationId,
    nodeId: config.nodeId,
  })

  runMigrations()
  nodeStateRepository.seedDefaults(config.nodeId, config.haMode)
  seedLocalPrintersIfEmpty()

  // Claim active lease (required for mutating Cloud sync calls)
  const claim = await cloudClient.claimActive()
  console.log('Claim active:', claim)

  await menuSyncService.bootstrapMenuFromCloud()
  await syncPullService.runOnce()
  await printService.processDueJobs()

  console.log('Sync test complete')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
