// routes/users.js - User Management Routes
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { verifyToken, checkPermission } = require('../middleware/auth');
const { sendEmail } = require('../utils/emailService');
const crypto = require('crypto');

// All routes require authentication
router.use(verifyToken);

// GET /users - List all users in tenant
router.get('/', checkPermission('users.view'), async (req, res) => {
    try {
        const { status = 'active', search, page = 1, limit = 50 } = req.query;
        const offset = (page - 1) * limit;

        let query = `
            SELECT u.id, u.email, u.first_name, u.last_name, u.avatar_url, 
                   u.phone, u.status, u.last_login, u.created_at,
                   GROUP_CONCAT(r.name SEPARATOR ', ') as roles
            FROM users u
            LEFT JOIN user_roles ur ON u.id = ur.user_id
            LEFT JOIN roles r ON ur.role_id = r.id
            WHERE u.tenant_id = ?
        `;

        const params = [req.user.tenantId];

        // Status filter
        if (status && status !== 'all') {
            query += ' AND u.status = ?';
            params.push(status);
        }

        // Search filter
        if (search) {
            query += ' AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)';
            const searchTerm = `%${search}%`;
            params.push(searchTerm, searchTerm, searchTerm);
        }

        query += ' GROUP BY u.id ORDER BY u.created_at DESC LIMIT ? OFFSET ?';
        params.push(parseInt(limit), parseInt(offset));

        const [users] = await db.query(query, params);

        // Get total count
        let countQuery = 'SELECT COUNT(*) as total FROM users WHERE tenant_id = ?';
        const countParams = [req.user.tenantId];
        
        if (status && status !== 'all') {
            countQuery += ' AND status = ?';
            countParams.push(status);
        }

        const [countResult] = await db.query(countQuery, countParams);

        res.json({
            users,
            pagination: {
                total: countResult[0].total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(countResult[0].total / limit)
            }
        });

    } catch (error) {
        console.error('List users error:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// GET /users/:id - Get single user details
router.get('/:id', checkPermission('users.view'), async (req, res) => {
    try {
        const { id } = req.params;

        const [users] = await db.query(
            `SELECT u.id, u.email, u.first_name, u.last_name, u.avatar_url, 
                    u.phone, u.status, u.last_login, u.created_at, u.preferences
             FROM users u
             WHERE u.id = ? AND u.tenant_id = ?`,
            [id, req.user.tenantId]
        );

        if (users.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        const user = users[0];

        // Get user roles
        const [roles] = await db.query(
            `SELECT r.id, r.name, r.description
             FROM roles r
             JOIN user_roles ur ON r.id = ur.role_id
             WHERE ur.user_id = ?`,
            [id]
        );

        // Get user permissions
        const [permissions] = await db.query(
            `SELECT DISTINCT p.name, p.description, p.category
             FROM permissions p
             JOIN role_permissions rp ON p.id = rp.permission_id
             JOIN user_roles ur ON rp.role_id = ur.role_id
             WHERE ur.user_id = ?`,
            [id]
        );

        res.json({
            ...user,
            roles,
            permissions
        });

    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// POST /users/invite - Invite new user
router.post('/invite',
    checkPermission('users.create'),
    [
        body('email').isEmail().normalizeEmail(),
        body('roleId').isInt(),
        body('firstName').trim().notEmpty(),
        body('lastName').trim().notEmpty()
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { email, roleId, firstName, lastName } = req.body;

            // Check if user already exists in this tenant
            const [existing] = await db.query(
                'SELECT id, status FROM users WHERE email = ? AND tenant_id = ?',
                [email, req.user.tenantId]
            );

            if (existing.length > 0) {
                return res.status(400).json({ 
                    error: 'User with this email already exists in your organization' 
                });
            }

            // Check if role exists and belongs to tenant
            const [roles] = await db.query(
                'SELECT id FROM roles WHERE id = ? AND tenant_id = ?',
                [roleId, req.user.tenantId]
            );

            if (roles.length === 0) {
                return res.status(404).json({ error: 'Role not found' });
            }

            // Generate invitation token
            const token = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

            // Create invitation record
            const [result] = await db.query(
                `INSERT INTO user_invitations (tenant_id, email, invited_by, token, role_id, expires_at, status) 
                 VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
                [req.user.tenantId, email, req.user.id, token, roleId, expiresAt]
            );

            // Send invitation email
            const inviteUrl = `${process.env.FRONTEND_URL}/accept-invite?token=${token}`;
            
            try {
                await sendEmail({
                    to: email,
                    subject: `You've been invited to join ${req.user.tenantName}`,
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                            <h2>Hello ${firstName}!</h2>
                            <p>You have been invited by <strong>${req.user.firstName} ${req.user.lastName}</strong> to join <strong>${req.user.tenantName}</strong> on our Project Management System.</p>
                            
                            <p>Click the button below to accept the invitation and set up your account:</p>
                            
                            <div style="text-align: center; margin: 30px 0;">
                                <a href="${inviteUrl}" 
                                   style="display: inline-block; padding: 12px 30px; background: #3B82F6; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
                                    Accept Invitation
                                </a>
                            </div>
                            
                            <p style="color: #666; font-size: 14px;">
                                This invitation expires in 7 days. If you didn't expect this invitation, you can safely ignore this email.
                            </p>
                            
                            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
                            
                            <p style="color: #999; font-size: 12px;">
                                If the button doesn't work, copy and paste this link into your browser:<br>
                                <a href="${inviteUrl}">${inviteUrl}</a>
                            </p>
                        </div>
                    `
                });
            } catch (emailError) {
                console.error('Failed to send invitation email:', emailError);
                // Continue even if email fails - user can be invited again
            }

            res.status(201).json({ 
                message: 'Invitation sent successfully',
                invitationId: result.insertId,
                inviteUrl // Include URL in response for testing
            });

        } catch (error) {
            console.error('Invite user error:', error);
            res.status(500).json({ error: 'Failed to send invitation' });
        }
    }
);

// POST /users/resend-invite - Resend invitation
router.post('/resend-invite',
    checkPermission('users.create'),
    [body('invitationId').isInt()],
    async (req, res) => {
        try {
            const { invitationId } = req.body;

            // Get invitation details
            const [invites] = await db.query(
                `SELECT ui.*, r.name as role_name
                 FROM user_invitations ui
                 JOIN roles r ON ui.role_id = r.id
                 WHERE ui.id = ? AND ui.tenant_id = ? AND ui.status = 'pending'`,
                [invitationId, req.user.tenantId]
            );

            if (invites.length === 0) {
                return res.status(404).json({ error: 'Invitation not found or already accepted' });
            }

            const invite = invites[0];

            // Generate new token and extend expiry
            const newToken = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

            // Update invitation
            await db.query(
                'UPDATE user_invitations SET token = ?, expires_at = ? WHERE id = ?',
                [newToken, expiresAt, invitationId]
            );

            // Resend email
            const inviteUrl = `${process.env.FRONTEND_URL}/accept-invite?token=${newToken}`;
            
            try {
                await sendEmail({
                    to: invite.email,
                    subject: `Reminder: Join ${req.user.tenantName}`,
                    html: `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                            <h2>Reminder</h2>
                            <p>This is a reminder that you have been invited to join <strong>${req.user.tenantName}</strong>.</p>
                            
                            <div style="text-align: center; margin: 30px 0;">
                                <a href="${inviteUrl}" 
                                   style="display: inline-block; padding: 12px 30px; background: #3B82F6; color: white; text-decoration: none; border-radius: 5px; font-weight: bold;">
                                    Accept Invitation
                                </a>
                            </div>
                            
                            <p style="color: #666; font-size: 14px;">
                                This invitation expires in 7 days.
                            </p>
                        </div>
                    `
                });
            } catch (emailError) {
                console.error('Failed to resend invitation email:', emailError);
            }

            res.json({ message: 'Invitation resent successfully' });

        } catch (error) {
            console.error('Resend invite error:', error);
            res.status(500).json({ error: 'Failed to resend invitation' });
        }
    }
);

// GET /users/invitations - List pending invitations
router.get('/invitations/pending', checkPermission('users.view'), async (req, res) => {
    try {
        const [invitations] = await db.query(
            `SELECT ui.id, ui.email, ui.status, ui.created_at, ui.expires_at,
                    r.name as role_name,
                    u.first_name as invited_by_first_name,
                    u.last_name as invited_by_last_name
             FROM user_invitations ui
             JOIN roles r ON ui.role_id = r.id
             JOIN users u ON ui.invited_by = u.id
             WHERE ui.tenant_id = ? AND ui.status = 'pending'
             ORDER BY ui.created_at DESC`,
            [req.user.tenantId]
        );

        res.json(invitations);

    } catch (error) {
        console.error('List invitations error:', error);
        res.status(500).json({ error: 'Failed to fetch invitations' });
    }
});

// PUT /users/:id/role - Change user role
router.put('/:id/role',
    checkPermission('users.edit'),
    [body('roleId').isInt()],
    async (req, res) => {
        try {
            const { id } = req.params;
            const { roleId } = req.body;

            // Don't allow changing your own role
            if (parseInt(id) === req.user.id) {
                return res.status(400).json({ error: 'Cannot change your own role' });
            }

            // Check if user exists in tenant
            const [users] = await db.query(
                'SELECT id FROM users WHERE id = ? AND tenant_id = ?',
                [id, req.user.tenantId]
            );

            if (users.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }

            // Check if role exists
            const [roles] = await db.query(
                'SELECT id FROM roles WHERE id = ? AND tenant_id = ?',
                [roleId, req.user.tenantId]
            );

            if (roles.length === 0) {
                return res.status(404).json({ error: 'Role not found' });
            }

            // Remove old roles and assign new role
            await db.query('DELETE FROM user_roles WHERE user_id = ?', [id]);
            await db.query(
                'INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)',
                [id, roleId]
            );

            // Create audit log
            await db.query(
                `INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_values, ip_address) 
                 VALUES (?, ?, 'update_role', 'user', ?, ?, ?)`,
                [req.user.tenantId, req.user.id, id, JSON.stringify({ roleId }), req.ip]
            );

            res.json({ message: 'User role updated successfully' });

        } catch (error) {
            console.error('Update role error:', error);
            res.status(500).json({ error: 'Failed to update role' });
        }
    }
);

// PUT /users/:id/status - Activate/deactivate user
router.put('/:id/status',
    checkPermission('users.edit'),
    [body('status').isIn(['active', 'inactive'])],
    async (req, res) => {
        try {
            const { id } = req.params;
            const { status } = req.body;

            // Don't allow deactivating yourself
            if (parseInt(id) === req.user.id) {
                return res.status(400).json({ error: 'Cannot change your own status' });
            }

            // Check if user exists
            const [users] = await db.query(
                'SELECT id FROM users WHERE id = ? AND tenant_id = ?',
                [id, req.user.tenantId]
            );

            if (users.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }

            // Update status
            await db.query(
                'UPDATE users SET status = ? WHERE id = ? AND tenant_id = ?',
                [status, id, req.user.tenantId]
            );

            // If deactivating, invalidate all sessions
            if (status === 'inactive') {
                await db.query(
                    'UPDATE user_sessions SET is_active = FALSE WHERE user_id = ?',
                    [id]
                );
            }

            // Create audit log
            await db.query(
                `INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, new_values, ip_address) 
                 VALUES (?, ?, 'update_status', 'user', ?, ?, ?)`,
                [req.user.tenantId, req.user.id, id, JSON.stringify({ status }), req.ip]
            );

            res.json({ 
                message: `User ${status === 'active' ? 'activated' : 'deactivated'} successfully` 
            });

        } catch (error) {
            console.error('Update status error:', error);
            res.status(500).json({ error: 'Failed to update status' });
        }
    }
);

// PUT /users/:id - Update user profile
router.put('/:id',
    checkPermission('users.edit'),
    [
        body('firstName').optional().trim().notEmpty(),
        body('lastName').optional().trim().notEmpty(),
        body('phone').optional().trim(),
        body('email').optional().isEmail().normalizeEmail()
    ],
    async (req, res) => {
        try {
            const { id } = req.params;
            const { firstName, lastName, phone, email } = req.body;

            // Check if user exists
            const [users] = await db.query(
                'SELECT id FROM users WHERE id = ? AND tenant_id = ?',
                [id, req.user.tenantId]
            );

            if (users.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }

            // If email is being changed, check if it's already taken
            if (email) {
                const [existingEmail] = await db.query(
                    'SELECT id FROM users WHERE email = ? AND id != ? AND tenant_id = ?',
                    [email, id, req.user.tenantId]
                );

                if (existingEmail.length > 0) {
                    return res.status(400).json({ error: 'Email already in use' });
                }
            }

            // Build update query
            const updates = {};
            if (firstName) updates.first_name = firstName;
            if (lastName) updates.last_name = lastName;
            if (phone !== undefined) updates.phone = phone;
            if (email) updates.email = email;

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ error: 'No fields to update' });
            }

            const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
            const values = [...Object.values(updates), id, req.user.tenantId];

            await db.query(
                `UPDATE users SET ${fields} WHERE id = ? AND tenant_id = ?`,
                values
            );

            res.json({ message: 'User updated successfully' });

        } catch (error) {
            console.error('Update user error:', error);
            res.status(500).json({ error: 'Failed to update user' });
        }
    }
);

// DELETE /users/:id - Remove user from tenant
router.delete('/:id',
    checkPermission('users.delete'),
    async (req, res) => {
        try {
            const { id } = req.params;

            // Don't allow deleting yourself
            if (parseInt(id) === req.user.id) {
                return res.status(400).json({ error: 'Cannot delete your own account' });
            }

            // Check if user exists
            const [users] = await db.query(
                'SELECT id, email, first_name, last_name FROM users WHERE id = ? AND tenant_id = ?',
                [id, req.user.tenantId]
            );

            if (users.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }

            const user = users[0];

            // Create audit log before deletion
            await db.query(
                `INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id, old_values, ip_address) 
                 VALUES (?, ?, 'delete', 'user', ?, ?, ?)`,
                [req.user.tenantId, req.user.id, id, JSON.stringify(user), req.ip]
            );

            // Delete user (cascade will handle related records)
            await db.query(
                'DELETE FROM users WHERE id = ? AND tenant_id = ?',
                [id, req.user.tenantId]
            );

            res.json({ message: 'User removed successfully' });

        } catch (error) {
            console.error('Delete user error:', error);
            res.status(500).json({ error: 'Failed to remove user' });
        }
    }
);

// GET /users/stats - Get user statistics
router.get('/stats/summary', checkPermission('users.view'), async (req, res) => {
    try {
        const [stats] = await db.query(
            `SELECT 
                COUNT(*) as total_users,
                SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_users,
                SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END) as inactive_users,
                SUM(CASE WHEN status = 'invited' THEN 1 ELSE 0 END) as invited_users,
                SUM(CASE WHEN last_login >= DATE_SUB(NOW(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) as active_last_week
             FROM users
             WHERE tenant_id = ?`,
            [req.user.tenantId]
        );

        res.json(stats[0]);

    } catch (error) {
        console.error('Get user stats error:', error);
        res.status(500).json({ error: 'Failed to fetch statistics' });
    }
});

module.exports = router;