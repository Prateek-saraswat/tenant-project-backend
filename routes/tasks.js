// routes/tasks.js - Task Management Routes
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { verifyToken, checkPermission } = require('../middleware/auth');

router.use(verifyToken);

// File upload configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// POST /tasks - Create task
router.post('/',
    checkPermission('tasks.create'),
    [
        body('projectId').isInt(),
        body('title').trim().notEmpty()
    ],
    async (req, res) => {
        try {
            const { projectId, title, description, status, priority, type, estimatedHours, dueDate, startDate } = req.body;

            const [result] = await db.query(
                `INSERT INTO tasks (tenant_id, project_id, title, description, status, priority, type, 
                                   estimated_hours, due_date, start_date, created_by) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [req.user.tenantId, projectId, title, description, status || 'todo', priority || 'medium', 
                 type || 'task', estimatedHours, dueDate, startDate, req.user.id]
            );

            res.status(201).json({ message: 'Task created', taskId: result.insertId });
        } catch (error) {
            console.error('Create task error:', error);
            res.status(500).json({ error: 'Failed to create task' });
        }
    }
);

// GET /tasks - List tasks with filters
router.get('/', checkPermission('tasks.view'), async (req, res) => {
    try {
        const { projectId, status, priority, assignedTo, search } = req.query;

        let query = `
            SELECT t.*, 
                   p.name as project_name, p.color as project_color,
                   u.first_name as creator_first_name, u.last_name as creator_last_name,
                   GROUP_CONCAT(DISTINCT CONCAT(au.first_name, ' ', au.last_name) SEPARATOR ', ') as assignees
            FROM tasks t
            JOIN projects p ON t.project_id = p.id
            JOIN users u ON t.created_by = u.id
            LEFT JOIN task_assignments ta ON t.id = ta.task_id
            LEFT JOIN users au ON ta.user_id = au.id
            WHERE t.tenant_id = ?
        `;

        const params = [req.user.tenantId];

        if (projectId) {
            query += ' AND t.project_id = ?';
            params.push(projectId);
        }
        if (status) {
            query += ' AND t.status = ?';
            params.push(status);
        }
        if (priority) {
            query += ' AND t.priority = ?';
            params.push(priority);
        }
        if (assignedTo) {
            query += ' AND ta.user_id = ?';
            params.push(assignedTo);
        }
        if (search) {
            query += ' AND (t.title LIKE ? OR t.description LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }

        query += ' GROUP BY t.id ORDER BY t.position ASC, t.created_at DESC';

        const [tasks] = await db.query(query, params);
        res.json(tasks);
    } catch (error) {
        console.error('List tasks error:', error);
        res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

// GET /tasks/:id - Get task details
router.get('/:id', checkPermission('tasks.view'), async (req, res) => {
    try {
        const { id } = req.params;

        const [tasks] = await db.query(
            `SELECT t.*, p.name as project_name, p.color as project_color,
                    u.first_name as creator_first_name, u.last_name as creator_last_name
             FROM tasks t
             JOIN projects p ON t.project_id = p.id
             JOIN users u ON t.created_by = u.id
             WHERE t.id = ? AND t.tenant_id = ?`,
            [id, req.user.tenantId]
        );

        if (tasks.length === 0) {
            return res.status(404).json({ error: 'Task not found' });
        }

        // Get assignees
        const [assignees] = await db.query(
            `SELECT u.id, u.first_name, u.last_name, u.email, u.avatar_url, ta.assigned_at
             FROM task_assignments ta
             JOIN users u ON ta.user_id = u.id
             WHERE ta.task_id = ?`,
            [id]
        );

        // Get comments
        const [comments] = await db.query(
            `SELECT tc.*, u.first_name, u.last_name, u.avatar_url
             FROM task_comments tc
             JOIN users u ON tc.user_id = u.id
             WHERE tc.task_id = ?
             ORDER BY tc.created_at DESC`,
            [id]
        );

        // Get attachments
        const [attachments] = await db.query(
            'SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at DESC',
            [id]
        );

        res.json({
            ...tasks[0],
            assignees,
            comments,
            attachments
        });
    } catch (error) {
        console.error('Get task error:', error);
        res.status(500).json({ error: 'Failed to fetch task' });
    }
});

// PUT /tasks/:id - Update task
router.put('/:id', checkPermission('tasks.edit'), async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const fields = Object.keys(updates)
            .map(key => `${key} = ?`)
            .join(', ');
        const values = [...Object.values(updates), id, req.user.tenantId];

        await db.query(
            `UPDATE tasks SET ${fields} WHERE id = ? AND tenant_id = ?`,
            values
        );

        res.json({ message: 'Task updated successfully' });
    } catch (error) {
        console.error('Update task error:', error);
        res.status(500).json({ error: 'Failed to update task' });
    }
});

// POST /tasks/:id/assign - Assign users to task
router.post('/:id/assign',
    checkPermission('tasks.edit'),
    [body('userIds').isArray()],
    async (req, res) => {
        try {
            const { id } = req.params;
            const { userIds } = req.body;

            // Clear existing assignments
            await db.query('DELETE FROM task_assignments WHERE task_id = ?', [id]);

            // Add new assignments
            for (const userId of userIds) {
                await db.query(
                    'INSERT INTO task_assignments (task_id, user_id) VALUES (?, ?)',
                    [id, userId]
                );

                // Notify user
                await db.query(
                    `INSERT INTO notifications (tenant_id, user_id, type, title, message, data) 
                     VALUES (?, ?, 'task_assigned', 'Task Assigned', 'You have been assigned a task', ?)`,
                    [req.user.tenantId, userId, JSON.stringify({ taskId: id })]
                );
            }

            res.json({ message: 'Task assigned successfully' });
        } catch (error) {
            console.error('Assign task error:', error);
            res.status(500).json({ error: 'Failed to assign task' });
        }
    }
);

// POST /tasks/:id/comments - Add comment
router.post('/:id/comments',
    checkPermission('tasks.view'),
    [body('comment').trim().notEmpty()],
    async (req, res) => {
        try {
            const { id } = req.params;
            const { comment, mentionedUsers } = req.body;

            const [result] = await db.query(
                `INSERT INTO task_comments (task_id, user_id, comment, mentioned_users) 
                 VALUES (?, ?, ?, ?)`,
                [id, req.user.id, comment, JSON.stringify(mentionedUsers || [])]
            );

            res.status(201).json({ message: 'Comment added', commentId: result.insertId });
        } catch (error) {
            console.error('Add comment error:', error);
            res.status(500).json({ error: 'Failed to add comment' });
        }
    }
);

// POST /tasks/:id/attachments - Upload attachment
router.post('/:id/attachments',
    checkPermission('tasks.view'),
    upload.single('file'),
    async (req, res) => {
        try {
            const { id } = req.params;
            const file = req.file;

            if (!file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            await db.query(
                `INSERT INTO task_attachments (task_id, user_id, filename, original_name, file_path, file_size, mime_type) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [id, req.user.id, file.filename, file.originalname, file.path, file.size, file.mimetype]
            );

            res.status(201).json({ message: 'File uploaded successfully', filename: file.filename });
        } catch (error) {
            console.error('Upload file error:', error);
            res.status(500).json({ error: 'Failed to upload file' });
        }
    }
);

// POST /tasks/:id/dependencies - Add dependency
router.post('/:id/dependencies',
    checkPermission('tasks.edit'),
    [body('dependsOnTaskId').isInt()],
    async (req, res) => {
        try {
            const { id } = req.params;
            const { dependsOnTaskId, dependencyType } = req.body;

            await db.query(
                `INSERT INTO task_dependencies (task_id, depends_on_task_id, dependency_type) 
                 VALUES (?, ?, ?)`,
                [id, dependsOnTaskId, dependencyType || 'finish_to_start']
            );

            res.json({ message: 'Dependency added' });
        } catch (error) {
            console.error('Add dependency error:', error);
            res.status(500).json({ error: 'Failed to add dependency' });
        }
    }
);

// POST /tasks/bulk-update - Bulk update tasks
router.post('/bulk-update',
    checkPermission('tasks.edit'),
    [body('taskIds').isArray(), body('updates').isObject()],
    async (req, res) => {
        try {
            const { taskIds, updates } = req.body;

            const fields = Object.keys(updates)
                .map(key => `${key} = ?`)
                .join(', ');
            const values = [...Object.values(updates), req.user.tenantId];

            await db.query(
                `UPDATE tasks SET ${fields} 
                 WHERE id IN (${taskIds.join(',')}) AND tenant_id = ?`,
                values
            );

            res.json({ message: 'Tasks updated successfully' });
        } catch (error) {
            console.error('Bulk update error:', error);
            res.status(500).json({ error: 'Failed to update tasks' });
        }
    }
);

// DELETE /tasks/:id - Delete task
router.delete('/:id', checkPermission('tasks.delete'), async (req, res) => {
    try {
        const { id } = req.params;

        await db.query(
            'DELETE FROM tasks WHERE id = ? AND tenant_id = ?',
            [id, req.user.tenantId]
        );

        res.json({ message: 'Task deleted successfully' });
    } catch (error) {
        console.error('Delete task error:', error);
        res.status(500).json({ error: 'Failed to delete task' });
    }
});

module.exports = router;