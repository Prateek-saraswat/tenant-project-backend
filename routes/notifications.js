// routes/notifications.js - Notifications Routes
const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { verifyToken } = require('../middleware/auth');

router.use(verifyToken);

// GET /notifications - Get user notifications
router.get('/', async (req, res) => {
    try {
        const { limit = 50, offset = 0, unreadOnly = false } = req.query;

        let query = `
            SELECT * FROM notifications 
            WHERE user_id = ?
        `;

        const params = [req.user.id];

        if (unreadOnly === 'true') {
            query += ' AND is_read = FALSE';
        }

        query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const [notifications] = await db.query(query, params);

        res.json(notifications);

    } catch (error) {
        console.error('Get notifications error:', error);
        res.status(500).json({ error: 'Failed to fetch notifications' });
    }
});

// GET /notifications/unread-count - Get unread count
router.get('/unread-count', async (req, res) => {
    try {
        const [result] = await db.query(
            'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = FALSE',
            [req.user.id]
        );

        res.json({ count: result[0].count });

    } catch (error) {
        console.error('Get unread count error:', error);
        res.status(500).json({ error: 'Failed to fetch count' });
    }
});

// POST /notifications/read - Mark notifications as read
router.post('/read', async (req, res) => {
    try {
        const { notificationIds } = req.body;

        if (!notificationIds || !Array.isArray(notificationIds)) {
            return res.status(400).json({ error: 'Invalid notification IDs' });
        }

        await db.query(
            `UPDATE notifications 
             SET is_read = TRUE, read_at = NOW() 
             WHERE id IN (${notificationIds.join(',')}) AND user_id = ?`,
            [req.user.id]
        );

        res.json({ message: 'Notifications marked as read' });

    } catch (error) {
        console.error('Mark read error:', error);
        res.status(500).json({ error: 'Failed to mark notifications' });
    }
});

// POST /notifications/preferences - Update notification preferences
router.post('/preferences', async (req, res) => {
    try {
        const { preferences } = req.body;

        await db.query(
            'UPDATE users SET preferences = ? WHERE id = ?',
            [JSON.stringify(preferences), req.user.id]
        );

        res.json({ message: 'Preferences updated' });

    } catch (error) {
        console.error('Update preferences error:', error);
        res.status(500).json({ error: 'Failed to update preferences' });
    }
});

module.exports = router;