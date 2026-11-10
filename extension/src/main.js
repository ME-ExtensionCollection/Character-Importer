// Char Importer: entry point. Boots quickly; slow work (library scan,
// leftover cleanup) runs after the buttons are in place.

await ciSettings.load();
ciShare.install();
ciInject.start();
ciQueueUi.ensure();

const ciUnsubscribeBadge = ciQueue.subscribe((q) => {
  if (!q.running && !q.paused) return ciInject.setBadge("");
  const left = q.items.filter((i) => i.state === "pending" || i.state === "running").length;
  ciInject.setBadge(left ? String(left) : "");
});

// Links the last session didn't finish: carried on if it was running, else shown paused
ciQueue.restore().then(
  (restored) => restored && ciQueueUi.show(),
  (error) => marinara.log.warn("Could not restore the import queue", error),
);

marinara.setTimeout(() => {
  void ciAssets.cleanupTempGallery().catch(() => undefined);
  void ciBridge.detect(1500);
  // Bring the index up to date in the background, then hand the owned list to the userscript
  ciLib
    .refresh()
    .then(() => ciLib.publishOwned())
    .catch((error) => marinara.log.warn("Library scan failed", error));
}, 2000);

const ciFlushOnHide = () => void ciSettings.flush();
window.addEventListener("pagehide", ciFlushOnHide);

marinara.onCleanup(async () => {
  window.removeEventListener("pagehide", ciFlushOnHide);
  ciUnsubscribeBadge();
  ciQueue.dispose();
  ciAssets.stopJob();
  ciInject.stop();
  ciQueueUi.dispose();
  ciImportUi.close();
  ciToolsUi.close();
  ciDom.closeAll();
  ciBridge.dispose();
  ciLib.dispose();
  await ciSettings.flush();
  ciIdb.close();
});

marinara.log.info("Char Importer loaded");
