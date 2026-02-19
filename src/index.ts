import { loadConfig } from "./config.js";
import { createBot } from "./bot.js";

async function main() {
  console.log("[acp-router] Loading config...");
  const config = await loadConfig();
  console.log(`[acp-router] Allowed chats: ${config.allowedChatIds.join(", ")}`);

  const bot = createBot(config);

  bot.catch((err) => {
    console.error("[acp-router] Bot error:", err);
  });

  console.log("[acp-router] Starting bot...");
  bot.start({
    onStart: () => console.log("[acp-router] Bot is running."),
  });
}

main().catch((err) => {
  console.error("[acp-router] Fatal:", err);
  process.exit(1);
});
