/**
 * CineStream Pro — User Data Router (Watch Progress, Reviews & Lists)
 */

import express from 'express';
import prisma from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// ----------------- WATCH PROGRESS -----------------

/**
 * Get all watch progress for the authenticated user
 */
router.get('/progress', authenticateToken, async (req, res) => {
  try {
    const list = await prisma.watchProgress.findMany({
      where: { userId: req.user.id },
      orderBy: { updatedAt: 'desc' }
    });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch watch progress' });
  }
});

/**
 * Save / Update watch progress
 */
router.post('/progress', authenticateToken, async (req, res) => {
  const { mediaId, mediaType, title, posterPath, season, episode, currentTime, duration, isCompleted } = req.body;

  if (!mediaId || !title || currentTime === undefined || !duration) {
    return res.status(400).json({ error: 'mediaId, title, currentTime, and duration are required' });
  }

  try {
    const record = await prisma.watchProgress.upsert({
      where: {
        userId_mediaId: {
          userId: req.user.id,
          mediaId: String(mediaId)
        }
      },
      update: {
        currentTime: Number(currentTime),
        duration: Number(duration),
        isCompleted: Boolean(isCompleted),
        season: season ? Number(season) : null,
        episode: episode ? Number(episode) : null,
        posterPath: posterPath || null,
        title
      },
      create: {
        userId: req.user.id,
        mediaId: String(mediaId),
        mediaType: mediaType || 'movie',
        title,
        posterPath: posterPath || null,
        season: season ? Number(season) : null,
        episode: episode ? Number(episode) : null,
        currentTime: Number(currentTime),
        duration: Number(duration),
        isCompleted: Boolean(isCompleted)
      }
    });

    res.json(record);
  } catch (err) {
    console.error('[Save Progress Error]:', err);
    res.status(500).json({ error: 'Failed to save progress' });
  }
});

// ----------------- REVIEWS & WATCH DIARY -----------------

/**
 * Get all reviews / diary entries for the user
 */
router.get('/reviews', authenticateToken, async (req, res) => {
  try {
    const list = await prisma.review.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' }
    });
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

/**
 * Add or update a review
 */
router.post('/reviews', authenticateToken, async (req, res) => {
  const { mediaId, mediaType, title, posterPath, rating, reviewText, watchedDate, rewatchCount } = req.body;

  if (!mediaId || !title || rating === undefined) {
    return res.status(400).json({ error: 'mediaId, title, and rating are required' });
  }

  try {
    const record = await prisma.review.upsert({
      where: {
        userId_mediaId: {
          userId: req.user.id,
          mediaId: String(mediaId)
        }
      },
      update: {
        rating: Number(rating),
        reviewText: reviewText || null,
        watchedDate: watchedDate ? new Date(watchedDate) : new Date(),
        rewatchCount: rewatchCount ? Number(rewatchCount) : 0,
        posterPath: posterPath || null,
        title
      },
      create: {
        userId: req.user.id,
        mediaId: String(mediaId),
        mediaType: mediaType || 'movie',
        title,
        posterPath: posterPath || null,
        rating: Number(rating),
        reviewText: reviewText || null,
        watchedDate: watchedDate ? new Date(watchedDate) : new Date(),
        rewatchCount: rewatchCount ? Number(rewatchCount) : 0
      }
    });

    res.json(record);
  } catch (err) {
    console.error('[Save Review Error]:', err);
    res.status(500).json({ error: 'Failed to save review' });
  }
});

// ----------------- CUSTOM LISTS -----------------

/**
 * Get all user lists
 */
router.get('/lists', authenticateToken, async (req, res) => {
  try {
    const lists = await prisma.userList.findMany({
      where: { userId: req.user.id },
      include: {
        items: {
          orderBy: { addedAt: 'desc' }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json(lists);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user lists' });
  }
});

/**
 * Create a new custom list
 */
router.post('/lists', authenticateToken, async (req, res) => {
  const { name, description, isPrivate } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'List name is required' });
  }

  try {
    const newList = await prisma.userList.create({
      data: {
        userId: req.user.id,
        name: name.trim(),
        description: description || null,
        isPrivate: Boolean(isPrivate)
      },
      include: { items: true }
    });

    res.status(201).json(newList);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create list' });
  }
});

/**
 * Add item to custom list
 */
router.post('/lists/:listId/items', authenticateToken, async (req, res) => {
  const { listId } = req.params;
  const { mediaId, mediaType, title, posterPath } = req.body;

  if (!mediaId || !title) {
    return res.status(400).json({ error: 'mediaId and title are required' });
  }

  try {
    const userList = await prisma.userList.findFirst({
      where: { id: listId, userId: req.user.id }
    });

    if (!userList) {
      return res.status(404).json({ error: 'List not found or unauthorized' });
    }

    const item = await prisma.listItem.upsert({
      where: {
        listId_mediaId: {
          listId,
          mediaId: String(mediaId)
        }
      },
      update: {
        title,
        posterPath: posterPath || null
      },
      create: {
        listId,
        mediaId: String(mediaId),
        mediaType: mediaType || 'movie',
        title,
        posterPath: posterPath || null
      }
    });

    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add item to list' });
  }
});

export default router;
