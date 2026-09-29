require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false,
});

const JWT_SECRET =
  process.env.JWT_SECRET || "development_secret_change_me";

// --------------------
// Database
// --------------------

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_url TEXT,
      coins INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id UUID PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      max_seats INTEGER NOT NULL DEFAULT 8,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
}

// --------------------
// JWT
// --------------------

function createToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
    },
    JWT_SECRET,
    {
      expiresIn: "7d",
    }
  );
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authentication required",
    });
  }

  const token = header.substring(7);

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    return res.status(401).json({
      error: "Invalid or expired token",
    });
  }
}

// --------------------
// Health
// --------------------

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      database: "connected",
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      database: "error",
    });
  }
});

// --------------------
// Register
// --------------------

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({
        error: "Username, email and password are required",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters",
      });
    }

    const existing = await pool.query(
      `SELECT id FROM users
       WHERE username = $1 OR email = $2`,
      [username, email]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: "Username or email already exists",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const userId = uuidv4();

    const result = await pool.query(
      `INSERT INTO users
       (id, username, email, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, email, avatar_url, coins`,
      [userId, username, email, passwordHash]
    );

    const user = result.rows[0];

    res.status(201).json({
      user,
      token: createToken(user),
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Registration failed",
    });
  }
});

// --------------------
// Login
// --------------------

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: "Email and password are required",
      });
    }

    const result = await pool.query(
      `SELECT *
       FROM users
       WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }

    const user = result.rows[0];

    const passwordOk = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordOk) {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar_url: user.avatar_url,
        coins: user.coins,
      },
      token: createToken(user),
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Login failed",
    });
  }
});

// --------------------
// Get rooms
// --------------------

app.get("/api/rooms", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        r.id,
        r.name,
        r.max_seats,
        r.created_at,
        u.username AS owner_username
      FROM rooms r
      JOIN users u ON u.id = r.owner_id
      ORDER BY r.created_at DESC
    `);

    res.json({
      rooms: result.rows,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not load rooms",
    });
  }
});

// --------------------
// Create room
// --------------------

app.post("/api/rooms", authMiddleware, async (req, res) => {
  try {
    const { name, maxSeats } = req.body;

    if (!name) {
      return res.status(400).json({
        error: "Room name is required",
      });
    }

    const roomId = uuidv4();

    const seats = Number(maxSeats) || 8;

    const result = await pool.query(
      `INSERT INTO rooms
       (id, name, owner_id, max_seats)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, owner_id, max_seats, created_at`,
      [roomId, name, req.user.id, seats]
    );

    res.status(201).json({
      room: result.rows[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not create room",
    });
  }
});

// --------------------
// Get current user
// --------------------

app.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
        id,
        username,
        email,
        avatar_url,
        coins,
        created_at
       FROM users
       WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: "User not found",
      });
    }

    res.json({
      user: result.rows[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not load profile",
    });
  }
});

// --------------------
// Add demo coins
// --------------------
// Temporary development endpoint.
// Real payment integration will be added later.

app.post("/api/coins/demo", authMiddleware, async (req, res) => {
  try {
    const amount = Number(req.body.amount) || 100;

    if (amount <= 0 || amount > 100000) {
      return res.status(400).json({
        error: "Invalid amount",
      });
    }

    const result = await pool.query(
      `UPDATE users
       SET coins = coins + $1
       WHERE id = $2
       RETURNING id, username, coins`,
      [amount, req.user.id]
    );

    res.json({
      user: result.rows[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Could not add coins",
    });
  }
});

// --------------------
// LiveKit token placeholder
// --------------------

app.get(
  "/api/rooms/:roomId/token",
  authMiddleware,
  async (req, res) => {
    res.status(501).json({
      error: "Live voice is not connected yet",
      message:
        "LiveKit integration will be added in the next step.",
    });
  }
);

// --------------------
// Start server
// --------------------

async function start() {
  try {
    await initDatabase();

    app.listen(PORT, () => {
      console.log(
        `Voice Chat API running on port ${PORT}`
      );
    });
  } catch (error) {
    console.error(
      "Could not start server:",
      error
    );

    process.exit(1);
  }
}

start();
