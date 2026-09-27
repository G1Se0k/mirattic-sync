export default defineBackground(() => {
  // Toolbar icon opens the chat side panel (outside the page, never over the player).
  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
