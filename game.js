/* pacme2 - minimal maze-chase game (Phaser 3, no build step) */

(() => {
  // ---------- Config ----------
  const TILE = 24;

  // Map legend:
  // # wall
  // . pellet
  // o power pellet
  // ' ' empty corridor (used after you eat pellets)
  const MAP = [
    "#####################",
    "#.........#.........#",
    "#.###.###.#.###.###.#",
    "#o###.###.#.###.###o#",
    "#...................#",
    "#.###.#.#####.#.###.#",
    "#.....#...#...#.....#",
    "#####.###.#.###.#####",
    "#.........#.........#",
    "#.###.###.#.###.###.#",
    "#o..#...........#..o#",
    "###.#.#.#####.#.#.###",
    "#.....#...#...#.....#",
    "#.#################.#",
    "#####################",
  ];

  const MAP_ROWS = MAP.length;
  const MAP_COLS = MAP[0].length;

  const GAME_W = MAP_COLS * TILE;
  const GAME_H = MAP_ROWS * TILE;

  const SPEED_PLAYER = 90; // pixels/sec
  const SPEED_GHOST = 78;  // pixels/sec

  const POWER_MS = 7000;

  // ---------- Helpers ----------
  function assert(condition, message) {
    if (!condition) throw new Error(`pacme2: ${message}`);
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function keyOf(col, row) {
    return `${col},${row}`;
  }

  function manhattan(a, b) {
    return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
  }

  function dirVec(name) {
    switch (name) {
      case "left": return { x: -1, y: 0, name };
      case "right": return { x: 1, y: 0, name };
      case "up": return { x: 0, y: -1, name };
      case "down": return { x: 0, y: 1, name };
      default: return { x: 0, y: 0, name: "none" };
    }
  }

  function opposite(dir) {
    if (dir.name === "left") return dirVec("right");
    if (dir.name === "right") return dirVec("left");
    if (dir.name === "up") return dirVec("down");
    if (dir.name === "down") return dirVec("up");
    return dirVec("none");
  }

  function snapToCenter(actor) {
    actor.x = actor.col * TILE + TILE / 2;
    actor.y = actor.row * TILE + TILE / 2;
  }

  function atTileCenter(actor, eps = 1.5) {
    const cx = actor.col * TILE + TILE / 2;
    const cy = actor.row * TILE + TILE / 2;
    return Math.abs(actor.x - cx) <= eps && Math.abs(actor.y - cy) <= eps;
  }

  // ---------- DOM HUD ----------
  const hud = {
    scoreEl: null,
    livesEl: null,
    statusEl: null,
    startBtn: null,
    init() {
      this.scoreEl = document.getElementById("score");
      this.livesEl = document.getElementById("lives");
      this.statusEl = document.getElementById("status");
      this.startBtn = document.getElementById("startBtn");
    },
    setScore(v) { if (this.scoreEl) this.scoreEl.textContent = String(v); },
    setLives(v) { if (this.livesEl) this.livesEl.textContent = String(v); },
    setStatus(v) { if (this.statusEl) this.statusEl.textContent = String(v); },
  };

  // ---------- Scene ----------
  class MainScene extends Phaser.Scene {
    constructor() {
      super({ key: "main" });
      this.staticGfx = null;
      this.dynamicGfx = null;

      this.grid = [];
      this.pellets = new Set();
      this.powerPellets = new Set();

      this.score = 0;
      this.lives = 3;

      this.powerUntil = 0;

      this.player = null;
      this.ghosts = [];

      this.keys = null;

      this.state = "READY"; // READY | PLAYING | WIN | GAMEOVER
    }

    create() {
      hud.init();

      this.validateMap();
      this.resetAll();

      // Phaser keyboard support
      this.keys = this.input.keyboard.addKeys({
        up: Phaser.Input.Keyboard.KeyCodes.UP,
        down: Phaser.Input.Keyboard.KeyCodes.DOWN,
        left: Phaser.Input.Keyboard.KeyCodes.LEFT,
        right: Phaser.Input.Keyboard.KeyCodes.RIGHT,
        w: Phaser.Input.Keyboard.KeyCodes.W,
        a: Phaser.Input.Keyboard.KeyCodes.A,
        s: Phaser.Input.Keyboard.KeyCodes.S,
        d: Phaser.Input.Keyboard.KeyCodes.D,
      });

      // On-screen D-pad: pointerdown sets desired direction
      const dpadButtons = Array.from(document.querySelectorAll(".dpadBtn"));
      dpadButtons.forEach((btn) => {
        btn.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          const dir = btn.getAttribute("data-dir");
          this.queuePlayerDir(dir);
        });
      });

      // Start / Restart button
      hud.startBtn?.addEventListener("click", () => {
        this.resetAll();
        this.state = "PLAYING";
        hud.setStatus("Playing");
      });

      // Graphics layers
      this.staticGfx = this.add.graphics();
      this.dynamicGfx = this.add.graphics();

      this.drawStaticLayer();
      this.drawDynamicLayer();

      // Optional: expose a tiny debug API
      window.pacme2Debug = {
        dump: () => ({
          score: this.score,
          lives: this.lives,
          pelletsLeft: this.pellets.size + this.powerPellets.size,
          state: this.state,
        }),
        forceWin: () => { this.pellets.clear(); this.powerPellets.clear(); },
      };

      hud.setStatus("Ready");
    }

    validateMap() {
      assert(MAP_ROWS >= 5 && MAP_COLS >= 5, "Map too small.");
      MAP.forEach((row, i) => {
        assert(row.length === MAP_COLS, `Map row ${i} length mismatch.`);
      });
    }

    buildGridAndItems() {
      this.grid = MAP.map((row) => row.split(""));
      this.pellets.clear();
      this.powerPellets.clear();

      for (let r = 0; r < MAP_ROWS; r++) {
        for (let c = 0; c < MAP_COLS; c++) {
          const ch = this.grid[r][c];
          if (ch === ".") this.pellets.add(keyOf(c, r));
          if (ch === "o") this.powerPellets.add(keyOf(c, r));
        }
      }
    }

    isWall(col, row) {
      if (row < 0 || row >= MAP_ROWS || col < 0 || col >= MAP_COLS) return true;
      return this.grid[row][col] === "#";
    }

    resetActorsOnly() {
      // Player start
      this.player = {
        col: 10, row: 10,
        x: 0, y: 0,
        dir: dirVec("left"),
        queuedDir: dirVec("left"),
        speed: SPEED_PLAYER,
        color: 0xffd43b,
      };
      snapToCenter(this.player);

      // Two ghosts (MVP)
      this.ghosts = [
        {
          name: "g1",
          col: 9, row: 6,
          x: 0, y: 0,
          dir: dirVec("left"),
          speed: SPEED_GHOST,
          baseColor: 0xff6b6b,
        },
        {
          name: "g2",
          col: 11, row: 6,
          x: 0, y: 0,
          dir: dirVec("right"),
          speed: SPEED_GHOST,
          baseColor: 0x54a0ff,
        },
      ];
      this.ghosts.forEach(snapToCenter);
    }

    resetAll() {
      this.buildGridAndItems();

      this.score = 0;
      this.lives = 3;
      this.powerUntil = 0;

      hud.setScore(this.score);
      hud.setLives(this.lives);

      this.resetActorsOnly();
      this.state = "READY";
      hud.setStatus("Ready");
    }

    queuePlayerDir(dirName) {
      this.player.queuedDir = dirVec(dirName);
    }

    readKeyboard() {
      const k = this.keys;
      if (!k) return;

      if (k.left.isDown || k.a.isDown) this.queuePlayerDir("left");
      else if (k.right.isDown || k.d.isDown) this.queuePlayerDir("right");
      else if (k.up.isDown || k.w.isDown) this.queuePlayerDir("up");
      else if (k.down.isDown || k.s.isDown) this.queuePlayerDir("down");
    }

    update(time, deltaMs) {
      if (this.state !== "PLAYING") {
        // keep animating blinking power pellets
        this.drawDynamicLayer(time);
        return;
      }

      this.readKeyboard();

      const dt = clamp(deltaMs / 1000, 0, 0.05);

      this.stepActorGrid(this.player, dt, true);

      // Eat pellets / power pellets
      this.consumeItemsAt(this.player.col, this.player.row, time);

      // Ghost AI + movement
      const frightened = (time < this.powerUntil);
      for (const g of this.ghosts) {
        this.ghostChooseDir(g, frightened);
        this.stepActorGrid(g, dt, false);
      }

      // Player–ghost collision
      for (const g of this.ghosts) {
        if (g.col === this.player.col && g.row === this.player.row) {
          if (frightened) {
            // Eat ghost: score bonus, reset ghost to start
            this.score += 200;
            hud.setScore(this.score);

            // Send ghost "home" (simple reset)
            if (g.name === "g1") { g.col = 9; g.row = 6; g.dir = dirVec("left"); }
            if (g.name === "g2") { g.col = 11; g.row = 6; g.dir = dirVec("right"); }
            snapToCenter(g);
          } else {
            this.loseLife();
            break;
          }
        }
      }

      // Win condition
      if (this.pellets.size + this.powerPellets.size === 0) {
        this.state = "WIN";
        hud.setStatus("You win! Press Start/Restart.");
      }

      this.drawDynamicLayer(time);
    }

    loseLife() {
      this.lives -= 1;
      hud.setLives(this.lives);

      if (this.lives <= 0) {
        this.state = "GAMEOVER";
        hud.setStatus("Game over. Press Start/Restart.");
        return;
      }

      // Reset only positions, keep eaten pellets
      this.resetActorsOnly();
      hud.setStatus("Ouch! Keep going.");
    }

    stepActorGrid(actor, dt, allowTurnQueue) {
      // Only allow turns at tile centers (classic feel)
      if (atTileCenter(actor)) {
        snapToCenter(actor);

        if (allowTurnQueue) {
          const q = actor.queuedDir;
          const nx = actor.col + q.x;
          const ny = actor.row + q.y;
          if (!this.isWall(nx, ny)) {
            actor.dir = q;
          }
        }

        // If current direction blocked, stop
        const nx = actor.col + actor.dir.x;
        const ny = actor.row + actor.dir.y;
        if (this.isWall(nx, ny)) {
          actor.dir = dirVec("none");
        }
      }

      // Move in pixels, then update tile coords when crossing centers
      const vx = actor.dir.x * actor.speed;
      const vy = actor.dir.y * actor.speed;

      actor.x += vx * dt;
      actor.y += vy * dt;

      // Update tile coordinates from pixel position
      actor.col = clamp(Math.floor(actor.x / TILE), 0, MAP_COLS - 1);
      actor.row = clamp(Math.floor(actor.y / TILE), 0, MAP_ROWS - 1);

      // Prevent entering walls: if the tile becomes a wall, snap back
      if (this.isWall(actor.col, actor.row)) {
        // Undo movement and snap to previous safe center
        actor.x -= vx * dt;
        actor.y -= vy * dt;
        actor.col = clamp(Math.floor(actor.x / TILE), 0, MAP_COLS - 1);
        actor.row = clamp(Math.floor(actor.y / TILE), 0, MAP_ROWS - 1);
        snapToCenter(actor);
        actor.dir = dirVec("none");
      }
    }

    consumeItemsAt(col, row, time) {
      const k = keyOf(col, row);

      if (this.pellets.has(k)) {
        this.pellets.delete(k);
        this.grid[row][col] = " ";
        this.score += 10;
        hud.setScore(this.score);
      }

      if (this.powerPellets.has(k)) {
        this.powerPellets.delete(k);
        this.grid[row][col] = " ";
        this.score += 50;
        hud.setScore(this.score);

        this.powerUntil = time + POWER_MS;
        hud.setStatus("Power mode!");
      }
    }

    ghostChooseDir(ghost, frightened) {
      // Only decide at tile centers
      if (!atTileCenter(ghost)) return;

      snapToCenter(ghost);

      const dirs = [dirVec("left"), dirVec("right"), dirVec("up"), dirVec("down")];

      // Possible moves = not wall, and avoid reversing unless forced
      const opp = opposite(ghost.dir).name;
      let options = dirs.filter((d) => !this.isWall(ghost.col + d.x, ghost.row + d.y));

      if (options.length >= 2) {
        options = options.filter((d) => d.name !== opp);
        if (options.length === 0) options = dirs.filter((d) => !this.isWall(ghost.col + d.x, ghost.row + d.y));
      }

      if (options.length === 0) {
        ghost.dir = dirVec("none");
        return;
      }

      if (frightened) {
        // Random walk
        ghost.dir = options[Math.floor(Math.random() * options.length)];
        return;
      }

      // Chase: mostly greedy, sometimes random to feel less deterministic
      const playerTile = { col: this.player.col, row: this.player.row };

      const RANDOM_CHANCE = 0.18;
      if (Math.random() < RANDOM_CHANCE) {
        ghost.dir = options[Math.floor(Math.random() * options.length)];
        return;
      }

      // Pick move that minimizes Manhattan distance to player
      let best = options[0];
      let bestScore = Infinity;
      for (const d of options) {
        const nextTile = { col: ghost.col + d.x, row: ghost.row + d.y };
        const dist = manhattan(nextTile, playerTile);
        if (dist < bestScore) {
          bestScore = dist;
          best = d;
        }
      }
      ghost.dir = best;
    }

    drawStaticLayer() {
      this.staticGfx.clear();

      // Background
      this.staticGfx.fillStyle(0x000000, 1);
      this.staticGfx.fillRect(0, 0, GAME_W, GAME_H);

      // Walls
      this.staticGfx.fillStyle(0x2b4cff, 1);
      for (let r = 0; r < MAP_ROWS; r++) {
        for (let c = 0; c < MAP_COLS; c++) {
          if (this.grid[r][c] === "#") {
            this.staticGfx.fillRect(c * TILE, r * TILE, TILE, TILE);
          }
        }
      }
    }

    drawDynamicLayer(time = 0) {
      this.dynamicGfx.clear();

      // Pellets
      this.dynamicGfx.fillStyle(0xeaeaea, 1);
      for (const k of this.pellets) {
        const [c, r] = k.split(",").map(Number);
        this.dynamicGfx.fillCircle(c * TILE + TILE / 2, r * TILE + TILE / 2, 2);
      }

      // Power pellets (blink)
      const blink = (Math.floor(time / 200) % 2) === 0;
      this.dynamicGfx.fillStyle(0xffffff, blink ? 1 : 0.35);
      for (const k of this.powerPellets) {
        const [c, r] = k.split(",").map(Number);
        this.dynamicGfx.fillCircle(c * TILE + TILE / 2, r * TILE + TILE / 2, 5);
      }

      // Player
      this.dynamicGfx.fillStyle(this.player.color, 1);
      this.dynamicGfx.fillCircle(this.player.x, this.player.y, 9);

      // Ghosts
      const frightened = (time < this.powerUntil);
      for (const g of this.ghosts) {
        const color = frightened ? 0x4dd4ff : g.baseColor;
        this.dynamicGfx.fillStyle(color, 1);
        this.dynamicGfx.fillCircle(g.x, g.y, 9);
      }
    }
  }

  // ---------- Create Phaser game ----------
  const config = {
    type: Phaser.AUTO,
    parent: "game-root",
    width: GAME_W,
    height: GAME_H,
    backgroundColor: "#000000",
    scene: [MainScene],
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  };

  // Phaser is a library you include and run in the browser (no “IDE” required).
  // See Phaser getting started and CDN installation docs. (Cited in the report text.)
  // eslint-disable-next-line no-new
  new Phaser.Game(config);
})();
