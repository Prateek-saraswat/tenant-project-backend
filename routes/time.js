// routes/time.js - Time Tracking Routes
const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const db = require('../config/database');
const { verifyToken, checkPermission } = require('../middleware/auth');

router.use(verifyToken);

// POST /time/start - Start timer for a task
router.post('/start',
    checkPermission('time.create'),
    [body('taskId').isInt()],
    async (req, res) => {
        try {
            const { taskId, description } = req.body;

            // Check if there's already an active timer
            const [active] = await db.query(
                'SELECT id FROM time_entries WHERE user_id = ? AND end_time IS NULL',
                [req.user.id]
            );

            if (active.length > 0) {
                return res.status(400).json({ error: 'Timer already running' });
            }

            // Get task and project info
            const [tasks] = await db.query(
                'SELECT project_id FROM tasks WHERE id = ? AND tenant_id = ?',
                [taskId, req.user.tenantId]
            );

            if (tasks.length === 0) {
                return res.status(404).json({ error: 'Task not found' });
            }

            const [result] = await db.query(
                `INSERT INTO time_entries (tenant_id, user_id, task_id, project_id, description, start_time) 
                 VALUES (?, ?, ?, ?, ?, NOW())`,
                [req.user.tenantId, req.user.id, taskId, tasks[0].project_id, description]
            );

            res.status(201).json({ 
                message: 'Timer started',
                entryId: result.insertId
            });

        } catch (error) {
            console.error('Start timer error:', error);
            res.status(500).json({ error: 'Failed to start timer' });
        }
    }
);

// POST /time/stop - Stop active timer
router.post('/stop', checkPermission('time.create'), async (req, res) => {
    try {
        // Find active timer
        const [entries] = await db.query(
            'SELECT id, start_time FROM time_entries WHERE user_id = ? AND end_time IS NULL',
            [req.user.id]
        );

        if (entries.length === 0) {
            return res.status(400).json({ error: 'No active timer' });
        }

        const entry = entries[0];
        
        // Calculate duration
        const startTime = new Date(entry.start_time);
        const endTime = new Date();
        const durationMinutes = Math.round((endTime - startTime) / 1000 / 60);

        // Update entry
        await db.query(
            'UPDATE time_entries SET end_time = NOW(), duration_minutes = ? WHERE id = ?',
            [durationMinutes, entry.id]
        );

        // Update task actual hours
        await db.query(
            `UPDATE tasks SET actual_hours = actual_hours + ? 
             WHERE id = (SELECT task_id FROM time_entries WHERE id = ?)`,
            [durationMinutes / 60, entry.id]
        );

        res.json({ 
            message: 'Timer stopped',
            duration: durationMinutes
        });

    } catch (error) {
        console.error('Stop timer error:', error);
        res.status(500).json({ error: 'Failed to stop timer' });
    }
});

// POST /time/manual - Add manual time entry
router.post('/manual',
    checkPermission('time.create'),
    [
        body('taskId').isInt(),
        body('startTime').isISO8601(),
        body('endTime').isISO8601()
    ],
    async (req, res) => {
        try {
            const { taskId, startTime, endTime, description, isBillable } = req.body;

            // Calculate duration
            const start = new Date(startTime);
            const end = new Date(endTime);
            const durationMinutes = Math.round((end - start) / 1000 / 60);

            if (durationMinutes <= 0) {
                return res.status(400).json({ error: 'Invalid time range' });
            }

            // Get project ID
            const [tasks] = await db.query(
                'SELECT project_id FROM tasks WHERE id = ? AND tenant_id = ?',
                [taskId, req.user.tenantId]
            );

            if (tasks.length === 0) {
                return res.status(404).json({ error: 'Task not found' });
            }

            const [result] = await db.query(
                `INSERT INTO time_entries (tenant_id, user_id, task_id, project_id, description, 
                                          start_time, end_time, duration_minutes, is_billable) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [req.user.tenantId, req.user.id, taskId, tasks[0].project_id, description,
                 startTime, endTime, durationMinutes, isBillable !== false]
            );

            // Update task actual hours
            await db.query(
                'UPDATE tasks SET actual_hours = actual_hours + ? WHERE id = ?',
                [durationMinutes / 60, taskId]
            );

            res.status(201).json({ 
                message: 'Time entry added',
                entryId: result.insertId
            });

        } catch (error) {
            console.error('Manual entry error:', error);
            res.status(500).json({ error: 'Failed to add time entry' });
        }
    }
);

// GET /time/daily - Get daily time summary
router.get('/daily', checkPermission('time.view'), async (req, res) => {
    try {
        const { date = new Date().toISOString().split('T')[0] } = req.query;

        const [entries] = await db.query(
            `SELECT te.*, t.title as task_title, p.name as project_name, p.color as project_color
             FROM time_entries te
             JOIN tasks t ON te.task_id = t.id
             JOIN projects p ON te.project_id = p.id
             WHERE te.user_id = ? AND DATE(te.start_time) = ?
             ORDER BY te.start_time DESC`,
            [req.user.id, date]
        );

        const totalMinutes = entries.reduce((sum, e) => sum + (e.duration_minutes || 0), 0);

        res.json({
            date,
            entries,
            totalMinutes,
            totalHours: (totalMinutes / 60).toFixed(2)
        });

    } catch (error) {
        console.error('Daily time error:', error);
        res.status(500).json({ error: 'Failed to fetch daily time' });
    }
});

// GET /time/weekly - Get weekly timesheet
router.get('/weekly', checkPermission('time.view'), async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        const [entries] = await db.query(
            `SELECT DATE(te.start_time) as date, 
                    p.id as project_id, p.name as project_name, p.color as project_color,
                    t.id as task_id, t.title as task_title,
                    SUM(te.duration_minutes) as total_minutes,
                    COUNT(*) as entry_count
             FROM time_entries te
             JOIN tasks t ON te.task_id = t.id
             JOIN projects p ON te.project_id = p.id
             WHERE te.user_id = ? AND DATE(te.start_time) BETWEEN ? AND ?
             GROUP BY DATE(te.start_time), p.id, t.id
             ORDER BY date DESC`,
            [req.user.id, startDate, endDate]
        );

        res.json(entries);

    } catch (error) {
        console.error('Weekly time error:', error);
        res.status(500).json({ error: 'Failed to fetch weekly time' });
    }
});

// POST /time/submit - Submit timesheet for approval
router.post('/submit',
    checkPermission('time.create'),
    [body('entryIds').isArray()],
    async (req, res) => {
        try {
            const { entryIds } = req.body;

            await db.query(
                `UPDATE time_entries SET status = 'submitted' 
                 WHERE id IN (${entryIds.join(',')}) AND user_id = ?`,
                [req.user.id]
            );

            res.json({ message: 'Timesheet submitted for approval' });

        } catch (error) {
            console.error('Submit timesheet error:', error);
            res.status(500).json({ error: 'Failed to submit timesheet' });
        }
    }
);

// POST /time/approve - Approve submitted timesheet
router.post('/approve',
    checkPermission('time.approve'),
    [body('entryIds').isArray()],
    async (req, res) => {
        try {
            const { entryIds } = req.body;

            await db.query(
                `UPDATE time_entries 
                 SET status = 'approved', approved_by = ?, approved_at = NOW()
                 WHERE id IN (${entryIds.join(',')}) AND tenant_id = ?`,
                [req.user.id, req.user.tenantId]
            );

            res.json({ message: 'Timesheet approved' });

        } catch (error) {
            console.error('Approve timesheet error:', error);
            res.status(500).json({ error: 'Failed to approve timesheet' });
        }
    }
);

module.exports = router;