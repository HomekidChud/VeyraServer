const { startVeyraServer } = require("./src/server");

if (require.main === module) {
  startVeyraServer();
  if (process.env.RENDER_SERVICE_ID === "srv-dbuqerg8v5cc739sq830") {
    require("./scripts/staging-neural-training").start();
  }
}
