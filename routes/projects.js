// routes/projects.js - Project Management Routes
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { verifyToken, checkPermission } = require('../middleware/auth');

// All routes require authentication
router.use(verifyToken);

// POST /projects - Create new project
router.post('/',
    checkPermission('projects.create'),
    [
        body('name').trim().notEmpty(),
        body('description').optional().trim()
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { name, description, code, startDate, endDate, budget, color } = req.body;

            const [result] = await db.query(
                `INSERT INTO projects (tenant_id, name, description, code, start_date, end_date, budget, color, created_by, status) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
                [req.user.tenantId, name, description, code, startDate, endDate, budget, color || '#3B82F6', req.user.id]
            );

            // Add creator as project member
            await db.query(
                `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')`,
                [result.insertId, req.user.id]
            );

            // Create audit log
            await db.query(
                `INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_values, ip_address) 
                 VALUES (?, ?, 'create', 'project', ?, ?, ?)`,
                [req.user.tenantId, req.user.id, result.insertId, JSON.stringify({ name }), req.ip]
            );

            res.status(201).json({
                message: 'Project created successfully',
                projectId: result.insertId
            });

        } catch (error) {
            console.error('Create project error:', error);
            res.status(500).json({ error: 'Failed to create project' });
        }
    }
);

// GET /projects - List all projects
router.get('/', checkPermission('projects.view'), async (req, res) => {
    try {
        const { status = 'active', search } = req.query;

        let query = `
            SELECT p.*, 
                   u.first_name as creator_first_name, u.last_name as creator_last_name,
                   (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as task_count,
                   (SELECT COUNT(*) FROM project_members WHERE project_id = p.id) as member_count
            FROM projects p
            JOIN users u ON p.created_by = u.id
            WHERE p.tenant_id = ? AND p.status = ?
        `;

        const params = [req.user.tenantId, status];

        if (search) {
            query += ` AND (p.name LIKE ? OR p.description LIKE ? OR p.code LIKE ?)`;
            params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }

        query += ` ORDER BY p.created_at DESC`;

        const [projects] = await db.query(query, params);

        res.json(projects);

    } catch (error) {
        console.error('List projects error:', error);
        res.status(500).json({ error: 'Failed to fetch projects' });
    }
});

// GET /projects/:id - Get project details
router.get('/:id', checkPermission('projects.view'), async (req, res) => {
    try {
        const { id } = req.params;

        const [projects] = await db.query(
            `SELECT p.*, 
                    u.first_name as creator_first_name, u.last_name as creator_last_name,
                    (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as task_count,
                    (SELECT COUNT(*) FROM project_members WHERE project_id = p.id) as member_count,
                    (SELECT SUM(actual_hours) FROM tasks WHERE project_id = p.id) as total_hours
             FROM projects p
             JOIN users u ON p.created_by = u.id
             WHERE p.id = ? AND p.tenant_id = ?`,
            [id, req.user.tenantId]
        );

        if (projects.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Get project members
        const [members] = await db.query(
            `SELECT pm.role, u.id, u.first_name, u.last_name, u.email, u.avatar_url, pm.added_at
             FROM project_members pm
             JOIN users u ON pm.user_id = u.id
             WHERE pm.project_id = ?`,
            [id]
        );

        res.json({
            ...projects[0],
            members
        });

    } catch (error) {
        console.error('Get project error:', error);
        res.status(500).json({ error: 'Failed to fetch project' });
    }
});

// PUT /projects/:id - Update project
router.put('/:id',
    checkPermission('projects.edit'),
    async (req, res) => {
        try {
            const { id } = req.params;
            const { name, description, code, startDate, endDate, budget, color, status } = req.body;

            // Check if project exists
            const [existing] = await db.query(
                'SELECT * FROM projects WHERE id = ? AND tenant_id = ?',
                [id, req.user.tenantId]
            );

            if (existing.length === 0) {
                return res.status(404).json({ error: 'Project not found' });
            }

            await db.query(
                `UPDATE projects 
                 SET name = COALESCE(?, name), 
                     description = COALESCE(?, description),
                     code = COALESCE(?, code),
                     start_date = COALESCE(?, start_date),
                     end_date = COALESCE(?, end_date),
                     budget = COALESCE(?, budget),
                     color = COALESCE(?, color),
                     status = COALESCE(?, status)
                 WHERE id = ?`,
                [name, description, code, startDate, endDate, budget, color, status, id]
            );

            // Audit log
            await db.query(
                `INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_values, new_values, ip_address) 
                 VALUES (?, ?, 'update', 'project', ?, ?, ?, ?)`,
                [req.user.tenantId, req.user.id, id, JSON.stringify(existing[0]), JSON.stringify(req.body), req.ip]
            );

            res.json({ message: 'Project updated successfully' });

        } catch (error) {
            console.error('Update project error:', error);
            res.status(500).json({ error: 'Failed to update project' });
        }
    }
);

// POST /projects/:id/archive - Archive project
router.post('/:id/archive',
    checkPermission('projects.edit'),
    async (req, res) => {
        try {
            const { id } = req.params;

            await db.query(
                'UPDATE projects SET status = "archived" WHERE id = ? AND tenant_id = ?',
                [id, req.user.tenantId]
            );

            res.json({ message: 'Project archived successfully' });

        } catch (error) {
            console.error('Archive project error:', error);
            res.status(500).json({ error: 'Failed to archive project' });
        }
    }
);

// POST /projects/:id/members - Add member to project
router.post('/:id/members',
    checkPermission('projects.edit'),
    [body('userId').isInt(), body('role').optional()],
    async (req, res) => {
        try {
            const { id } = req.params;
            const { userId, role = 'member' } = req.body;

            // Check if user exists in tenant
            const [users] = await db.query(
                'SELECT id FROM users WHERE id = ? AND tenant_id = ? AND status = "active"',
                [userId, req.user.tenantId]
            );

            if (users.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }

            // Add member
            await db.query(
                `INSERT INTO project_members (project_id, user_id, role) 
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE role = ?`,
                [id, userId, role, role]
            );

            // Create notification
            await db.query(
                `INSERT INTO notifications (tenant_id, user_id, type, title, message, data) 
                 VALUES (?, ?, 'project_added', 'Added to Project', 'You have been added to a project', ?)`,
                [req.user.tenantId, userId, JSON.stringify({ projectId: id })]
            );

            res.json({ message: 'Member added successfully' });

        } catch (error) {
            console.error('Add member error:', error);
            res.status(500).json({ error: 'Failed to add member' });
        }
    }
);

// DELETE /projects/:id/members/:userId - Remove member from project
router.delete('/:id/members/:userId',
    checkPermission('projects.edit'),
    async (req, res) => {
        try {
            const { id, userId } = req.params;

            await db.query(
                'DELETE FROM project_members WHERE project_id = ? AND user_id = ?',
                [id, userId]
            );

            res.json({ message: 'Member removed successfully' });

        } catch (error) {
            console.error('Remove member error:', error);
            res.status(500).json({ error: 'Failed to remove member' });
        }
    }
);

module.exports = router;