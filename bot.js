require("dotenv").config();

const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const Vec3 = require("vec3");
const fs = require("fs");

let config;

try {
  config = JSON.parse(
    fs.readFileSync("config.json", "utf8")
  );
} catch (err) {
  console.log("❌ config.json error");
  process.exit(1);
}

const botOptions = {
  host:
    process.env.MINECRAFT_HOST ||
    "gameplanet.aternos.me",

  port:
    Number(
      process.env.MINECRAFT_PORT
    ) || 16548,

  username:
    process.env.MINECRAFT_USERNAME ||
    "Placer",

  version: "1.21.1",

  auth: "offline"
};

let bot;

let mcData;

let isProcessing = false;
let isSleeping = false;
let reconnecting = false;

let patrolLoop = null;
let combatLoop = null;
let creativeLoop = null;

function delay(ms) {
  return new Promise((r) =>
    setTimeout(r, ms)
  );
}

function createBot() {

  if (bot) {
    try {
      bot.removeAllListeners();
      bot.quit();
    } catch {}
  }

  console.log(
    "🧠 Starting AI Brain..."
  );

  bot =
    mineflayer.createBot(
      botOptions
    );

  bot.loadPlugin(pathfinder);

  setupBot();
}

createBot();

function setupBot() {

  bot.once(
    "spawn",
    async () => {

      console.log(
        "✅ AI Brain Online"
      );

      reconnecting = false;

      mcData =
        require(
          "minecraft-data"
        )(bot.version);

      const movements =
        new Movements(
          bot,
          mcData
        );

      movements.canDig = false;

      movements.allow1by1towers = false;

      bot.pathfinder.setMovements(
        movements
      );

      await delay(3000);

      bot.chat(
        "/gamemode creative"
      );

      await delay(1000);

      startCreativeProtection();

      startCombatLoop();

      startPatrolLoop();
    }
  );

  bot.on(
    "kicked",
    (reason) => {

      console.log(
        "⚠️ Kicked:",
        reason
      );

      reconnect();
    }
  );

  bot.on(
    "end",
    () => {

      console.log(
        "⚠️ Disconnected"
      );

      reconnect();
    }
  );

  bot.on(
    "error",
    (err) => {

      console.log(
        "⚠️ Error:",
        err.message
      );
    }
  );
}

function reconnect() {

  if (reconnecting) return;

  reconnecting = true;

  clearInterval(
    patrolLoop
  );

  clearInterval(
    combatLoop
  );

  clearInterval(
    creativeLoop
  );

  setTimeout(() => {

    createBot();

  }, 15000);
}

function startCreativeProtection() {

  clearInterval(
    creativeLoop
  );

  creativeLoop =
    setInterval(() => {

      if (!bot?.entity)
        return;

      try {

        bot.chat(
          "/gamemode creative"
        );

      } catch {}

    }, 15000);
}

function startCombatLoop() {

  clearInterval(
    combatLoop
  );

  combatLoop =
    setInterval(async () => {

      if (
        !bot?.entity ||
        isSleeping
      ) return;

      try {

        await combatScan();

      } catch {}

    }, 1000);
}

function startPatrolLoop() {

  clearInterval(
    patrolLoop
  );

  patrolLoop =
    setInterval(async () => {

      if (
        !bot?.entity ||
        isProcessing ||
        isSleeping
      ) return;

      isProcessing = true;

      try {

        if (
          config.autoSleep &&
          (
            bot.time.timeOfDay >=
              13000 ||
            bot.isRaining
          )
        ) {

          await sleepMode();

          isProcessing = false;

          return;
        }

        await cleanTerritory();

        await walkCircle(
          true
        );

        await placeBreak();

        await walkCircle(
          false
        );

        await placeBreak();

      } catch (err) {

        console.log(
          "Loop Error:",
          err.message
        );
      }

      isProcessing = false;

    }, 2500);
}

async function walkCircle(
  clockwise = true
) {

  if (!bot?.entity)
    return;

  const points =
    config.pointsPerCircle ||
    8;

  for (
    let i = 0;
    i < points;
    i++
  ) {

    if (
      !bot?.entity ||
      isSleeping
    ) return;

    const angle =
      (
        (2 * Math.PI * i) /
        points
      ) *
      (
        clockwise
          ? 1
          : -1
      );

    const x =
      config.circleCenter.x +
      config.radius *
        Math.cos(angle);

    const z =
      config.circleCenter.z +
      config.radius *
        Math.sin(angle);

    try {

      bot.pathfinder.setGoal(
        new goals.GoalNear(
          x,
          config.circleCenter.y,
          z,
          2
        )
      );

      await waitForMove(
        x,
        z
      );

      await antiStuck();

    } catch {}
  }
}

async function waitForMove(
  x,
  z
) {

  return new Promise(
    (resolve) => {

      let finished =
        false;

      const timeout =
        setTimeout(() => {

          if (
            !finished
          ) {

            finished =
              true;

            clearInterval(
              checker
            );

            resolve();
          }

        }, 5000);

      const checker =
        setInterval(() => {

          if (
            !bot?.entity
          ) {

            clearTimeout(
              timeout
            );

            clearInterval(
              checker
            );

            return resolve();
          }

          const dist =
            bot.entity.position.distanceTo(
              new Vec3(
                x,
                config
                  .circleCenter
                  .y,
                z
              )
            );

          if (
            dist < 2.5 &&
            !finished
          ) {

            finished =
              true;

            clearTimeout(
              timeout
            );

            clearInterval(
              checker
            );

            resolve();
          }

        }, 200);
    }
  );
}

async function antiStuck() {

  if (!bot?.entity)
    return;

  const start =
    bot.entity.position.clone();

  await delay(1200);

  if (!bot?.entity)
    return;

  const end =
    bot.entity.position.clone();

  if (
    start.distanceTo(end) <
    0.5
  ) {

    console.log(
      "⚠️ Stuck"
    );

    try {

      bot.setControlState(
        "jump",
        true
      );

      bot.setControlState(
        "forward",
        true
      );

      await delay(700);

      bot.setControlState(
        "jump",
        false
      );

      bot.setControlState(
        "forward",
        false
      );

    } catch {}
  }
}

async function combatScan() {

  if (!bot?.entity)
    return;

  const center =
    new Vec3(
      config.circleCenter.x,
      config.circleCenter.y,
      config.circleCenter.z
    );

  const target =
    bot.nearestEntity(
      (e) => {

        if (
          e.type !== "mob"
        )
          return false;

        const hostile =
          [
            "zombie",
            "skeleton",
            "spider",
            "creeper"
          ];

        const valid =
          hostile.some(
            (h) =>
              e.name
                .toLowerCase()
                .includes(
                  h
                )
          );

        if (!valid)
          return false;

        return (
          e.position.distanceTo(
            center
          ) <=
          config.radius +
            3
        );
      }
    );

  if (!target)
    return;

  try {

    await bot.lookAt(
      target.position.offset(
        0,
        1,
        0
      )
    );

    if (
      bot.entity.position.distanceTo(
        target.position
      ) < 4
    ) {

      bot.attack(
        target
      );
    }

  } catch {}
}

async function cleanTerritory() {

  if (!bot?.entity)
    return;

  const blocks =
    bot.findBlocks({
      matching:
        (block) => {

          return (
            block.name !==
              "air" &&
            !block.name.includes(
              "bed"
            ) &&
            block.position.y >=
              87
          );
        },

      maxDistance:
        config.radius,

      count: 5
    });

  for (const pos of blocks) {

    try {

      const block =
        bot.blockAt(
          pos
        );

      if (!block)
        continue;

      await bot.lookAt(
        block.position.offset(
          0.5,
          0.5,
          0.5
        )
      );

      await bot.dig(
        block,
        true
      );

      await delay(100);

    } catch {}
  }
}

async function ensureItem(
  name
) {

  try {

    bot.chat(
      `/give ${bot.username} ${name} 1`
    );

    await delay(500);

  } catch {}
}

async function placeBreak() {

  if (!bot?.entity)
    return;

  try {

    const blockName =
      config.blockType ||
      "dirt";

    await ensureItem(
      blockName
    );

    const itemData =
      mcData.itemsByName[
        blockName
      ];

    const item =
      bot.inventory.findInventoryItem(
        itemData.id
      );

    if (!item)
      return;

    await bot.equip(
      item,
      "hand"
    );

    const reference =
      bot.blockAt(
        bot.entity.position
          .floored()
          .offset(
            0,
            -1,
            0
          )
      );

    if (!reference)
      return;

    await bot.placeBlock(
      reference,
      new Vec3(
        0,
        1,
        0
      )
    );

    await delay(300);

    const placed =
      bot.blockAt(
        reference.position.offset(
          0,
          1,
          0
        )
      );

    if (
      placed &&
      placed.name !==
        "air"
    ) {

      await bot.lookAt(
        placed.position.offset(
          0.5,
          0.5,
          0.5
        )
      );

      await bot.dig(
        placed,
        true
      );
    }

  } catch (err) {

    console.log(
      "Place Error:",
      err.message
    );
  }
}

async function sleepMode() {

  if (
    isSleeping ||
    !bot?.entity
  ) return;

  isSleeping = true;

  console.log(
    "🌙 Sleep Mode"
  );

  try {

    bot.pathfinder.setGoal(
      null
    );

    bot.chat(
      "/kill @e[type=!player,distance=..15]"
    );

    await delay(1500);

    const bedNames =
      [
        "white_bed",
        "red_bed",
        "blue_bed",
        "yellow_bed"
      ];

    let bed =
      bot.findBlock({
        matching:
          (b) =>
            bedNames.includes(
              b.name
            ),

        maxDistance: 20
      });

    if (!bed) {

      await ensureItem(
        "white_bed"
      );

      const item =
        bot.inventory.findInventoryItem(
          mcData.itemsByName[
            "white_bed"
          ].id
        );

      if (item) {

        await bot.equip(
          item,
          "hand"
        );

        const ref =
          bot.blockAt(
            bot.entity.position
              .floored()
              .offset(
                0,
                -1,
                0
              )
          );

        if (ref) {

          await bot.placeBlock(
            ref,
            new Vec3(
              0,
              1,
              0
            )
          );

          await delay(1000);

          bed =
            bot.findBlock({
              matching:
                (b) =>
                  bedNames.includes(
                    b.name
                  ),

              maxDistance: 10
            });
        }
      }
    }

    if (!bed) {

      isSleeping =
        false;

      return;
    }

    await bot.lookAt(
      bed.position.offset(
        0.5,
        0.5,
        0.5
      ),
      true
    );

    for (
      let i = 0;
      i < 3;
      i++
    ) {

      try {

        console.log(
          `🛌 Sleep Attempt ${i + 1}`
        );

        await bot.sleep(
          bed
        );

        break;

      } catch {

        await delay(
          1000
        );
      }
    }

    bot.once(
      "wake",
      () => {

        console.log(
          "☀️ Awake"
        );

        isSleeping =
          false;
      }
    );

    setTimeout(() => {

      isSleeping =
        false;

    }, 15000);

  } catch (err) {

    console.log(
      "Sleep Error:",
      err.message
    );

    isSleeping = false;
  }
}
