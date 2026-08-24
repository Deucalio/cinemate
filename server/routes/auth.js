/**
 * CineStream Pro — Authentication Router
 */

import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'cinestream_super_secret_jwt_key_2026';

/**
 * Register a new user
 */
router.post('/register', async (req, res) => {
  const { username, email, password, avatarUrl } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password are required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { email: email.toLowerCase().trim() },
          { username: username.toLowerCase().trim() }
        ]
      }
    });

    if (existing) {
      if (existing.email === email.toLowerCase().trim()) {
        return res.status(409).json({ error: 'Email is already registered' });
      }
      return res.status(409).json({ error: 'Username is already taken' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const user = await prisma.user.create({
      data: {
        username: username.toLowerCase().trim(),
        email: email.toLowerCase().trim(),
        passwordHash,
        avatarUrl: avatarUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username)}`
      },
      select: {
        id: true,
        username: true,
        email: true,
        avatarUrl: true,
        role: true,
        createdAt: true
      }
    });

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.status(201).json({
      user,
      token
    });
  } catch (err) {
    console.error('[Auth Register Error]:', err);
    res.status(500).json({ error: 'Failed to create user account' });
  }
});

/**
 * Login existing user
 */
router.post('/login', async (req, res) => {
  const { login, password } = req.body; // login can be username or email

  if (!login || !password) {
    return res.status(400).json({ error: 'Username/email and password are required' });
  }

  try {
    const cleanLogin = login.toLowerCase().trim();
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: cleanLogin },
          { username: cleanLogin }
        ]
      }
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatarUrl: user.avatarUrl,
        role: user.role,
        createdAt: user.createdAt
      },
      token
    });
  } catch (err) {
    console.error('[Auth Login Error]:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

/**
 * Get current authenticated user profile
 */
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        username: true,
        email: true,
        avatarUrl: true,
        role: true,
        createdAt: true,
        _count: {
          select: {
            watchProgress: true,
            reviews: true,
            userLists: true
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

export default router;
