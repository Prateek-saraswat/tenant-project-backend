// routes/roles.js - Roles & Permissions Management
const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const db = require('../config/database');
const { verifyToken, checkPermission } = require('../middleware/auth');

router.use(verifyToken);

// GET /roles - Get all roles
router.get('/', checkPermission('users.view'), async (req, res) => {
    try {
        const [roles] = await db.query(
            'SELECT * FROM roles WHERE tenant_id = ? ORDER BY name',
            [req.user.tenantId]
        );

        // Get permissions for each role
        for (let role of roles) {
            const [perms] = await db.query(
                `SELECT p.* FROM permissions p
                 JOIN role_permissions rp ON p.id = rp.permission_id
                 WHERE rp.role_id = ?`,
                [role.id]
            );
            role.permissions = perms;
        }

        res.json(roles);

    } catch (error) {
        console.error('Get roles error:', error);
        res.status(500).json({ error: 'Failed to fetch roles' });
    }
});

// GET /permissions - Get all permissions
router.get('/permissions', async (req, res) => {
    try {
        const [permissions] = await db.query(
            'SELECT * FROM permissions ORDER BY category, name'
        );

        // Group by category
        const grouped = permissions.reduce((acc, perm) => {
            const cat = perm.category || 'other';
            if (!acc[cat]) acc[cat] = [];
            acc[cat].push(perm);
            return acc;
        }, {});

        res.json(grouped);

    } catch (error) {
        console.error('Get permissions error:', error);
        res.status(500).json({ error: 'Failed to fetch permissions' });
    }
});

// POST /roles - Create custom role
router.post('/',
    checkPermission('users.edit'),
    [
        body('name').trim().notEmpty(),
        body('permissionIds').isArray()
    ],
    async (req, res) => {
        try {
            const { name, description, permissionIds } = req.body;

            // Create role
            const [result] = await db.query(
                'INSERT INTO roles (tenant_id, name, description, is_system_role) VALUES (?, ?, ?, FALSE)',
                [req.user.tenantId, name, description]
            );

            const roleId = result.insertId;

            // Assign permissions
            for (const permId of permissionIds) {
                await db.query(
                    'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
                    [roleId, permId]
                );
            }

            res.status(201).json({ 
                message: 'Role created successfully',
                roleId 
            });

        } catch (error) {
            console.error('Create role error:', error);
            res.status(500).json({ error: 'Failed to create role' });
        }
    }
);

// PUT /roles/:id - Update role permissions
router.put('/:id',
    checkPermission('users.edit'),
    [body('permissionIds').isArray()],
    async (req, res) => {
        try {
            const { id } = req.params;
            const { name, description, permissionIds } = req.body;

            // Check if role is system role
            const [roles] = await db.query(
                'SELECT is_system_role FROM roles WHERE id = ? AND tenant_id = ?',
                [id, req.user.tenantId]
            );

            if (roles.length === 0) {
                return res.status(404).json({ error: 'Role not found' });
            }

            if (roles[0].is_system_role) {
                return res.status(400).json({ error: 'Cannot modify system role' });
            }

            // Update role
            if (name || description) {
                await db.query(
                    'UPDATE roles SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?',
                    [name, description, id]
                );
            }

            // Update permissions
            if (permissionIds) {
                await db.query('DELETE FROM role_permissions WHERE role_id = ?', [id]);
                for (const permId of permissionIds) {
                    await db.query(
                        'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
                        [id, permId]
                    );
                }
            }

            res.json({ message: 'Role updated successfully' });

        } catch (error) {
            console.error('Update role error:', error);
            res.status(500).json({ error: 'Failed to update role' });
        }
    }
);

module.exports = router;