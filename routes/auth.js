// routes/auth.js - Authentication Routes
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { sendEmail } = require('../utils/emailService');
const crypto = require('crypto');

// Validation Rules
const registerValidation = [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }),
    body('firstName').trim().notEmpty(),
    body('lastName').trim().notEmpty(),
    body('organizationName').trim().notEmpty()
];

const loginValidation = [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
];

// POST /auth/register - Register new user and organization
router.post('/register', registerValidation, async (req, res) => {
    console.log("REGISTER BODY:", req.body);
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { email, password, firstName, lastName, organizationName } = req.body;

        // Check if email already exists
        const [existing] = await db.query(
            'SELECT id FROM users WHERE email = ?',
            [email]
        );

        if (existing.length > 0) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        const connection = await db.getConnection();
        await connection.beginTransaction();

        try {
            // Create tenant (organization)
            const slug = organizationName.toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '') + '-' + Date.now();

            const [tenantResult] = await connection.query(
                `INSERT INTO tenants (name, slug, plan, plan_limits, status) 
                 VALUES (?, ?, 'free', ?, 'active')`,
                [
                    organizationName,
                    slug,
                    JSON.stringify({ users: 5, projects: 3, storage_gb: 1 })
                ]
            );

            const tenantId = tenantResult.insertId;

            // Create default roles
            const [adminRole] = await connection.query(
                `INSERT INTO roles (tenant_id, name, description, is_system_role) 
                 VALUES (?, 'Admin', 'Full system access', TRUE)`,
                [tenantId]
            );

            const adminRoleId = adminRole.insertId;

            // Assign all permissions to admin role
            const [allPermissions] = await connection.query('SELECT id FROM permissions');
            for (const perm of allPermissions) {
                await connection.query(
                    'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
                    [adminRoleId, perm.id]
                );
            }

            // Create other default roles
            await connection.query(
                `INSERT INTO roles (tenant_id, name, description, is_system_role) 
                 VALUES 
                 (?, 'Manager', 'Project and team management', TRUE),
                 (?, 'Member', 'Basic project access', TRUE)`,
                [tenantId, tenantId]
            );

            // Hash password
            const passwordHash = await bcrypt.hash(password, 10);

            // Create user
            const [userResult] = await connection.query(
                `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, status, email_verified) 
                 VALUES (?, ?, ?, ?, ?, 'active', TRUE)`,
                [tenantId, email, passwordHash, firstName, lastName]
            );

            const userId = userResult.insertId;

            // Assign admin role to user
            await connection.query(
                'INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)',
                [userId, adminRoleId]
            );

            await connection.commit();
            connection.release();

            // Generate tokens
            const accessToken = jwt.sign(
                { userId, tenantId },
                process.env.JWT_SECRET,
                { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
            );

            const refreshToken = jwt.sign(
                { userId, tenantId },
                process.env.JWT_REFRESH_SECRET,
                { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
            );

            // Store refresh token
            const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
            await db.query(
                `INSERT INTO user_sessions (user_id, refresh_token, device_info, ip_address, expires_at) 
                 VALUES (?, ?, ?, ?, ?)`,
                [userId, refreshToken, req.headers['user-agent'], req.ip, expiresAt]
            );

            res.status(201).json({
                message: 'Registration successful',
                user: {
                    id: userId,
                    email,
                    firstName,
                    lastName,
                    tenantId,
                    tenantName: organizationName
                },
                accessToken,
                refreshToken
            });

        } catch (error) {
            await connection.rollback();
            connection.release();
            throw error;
        }

    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// POST /auth/login - User login
router.post('/login', loginValidation, async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { email, password, rememberMe } = req.body;

        // Fetch user with tenant info
        const [users] = await db.query(
            `SELECT u.*, t.name as tenant_name, t.status as tenant_status
             FROM users u
             JOIN tenants t ON u.tenant_id = t.id
             WHERE u.email = ? AND u.status = 'active'`,
            [email]
        );

        if (users.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const user = users[0];

        if (user.tenant_status !== 'active') {
            return res.status(403).json({ error: 'Organization is suspended' });
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Generate tokens
        const expiresIn = rememberMe ? '30d' : '1h';
        const refreshExpiresIn = rememberMe ? '90d' : '7d';

        const accessToken = jwt.sign(
            { userId: user.id, tenantId: user.tenant_id },
            process.env.JWT_SECRET,
            { expiresIn }
        );

        const refreshToken = jwt.sign(
            { userId: user.id, tenantId: user.tenant_id },
            process.env.JWT_REFRESH_SECRET,
            { expiresIn: refreshExpiresIn }
        );

        // Store refresh token
        const days = rememberMe ? 90 : 7;
        const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
        
        await db.query(
            `INSERT INTO user_sessions (user_id, refresh_token, device_info, ip_address, user_agent, expires_at) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                user.id,
                refreshToken,
                req.headers['user-agent'],
                req.ip,
                req.headers['user-agent'],
                expiresAt
            ]
        );

        // Update last login
        await db.query(
            'UPDATE users SET last_login = NOW() WHERE id = ?',
            [user.id]
        );

        res.json({
            message: 'Login successful',
            user: {
                id: user.id,
                email: user.email,
                firstName: user.first_name,
                lastName: user.last_name,
                tenantId: user.tenant_id,
                tenantName: user.tenant_name,
                avatar: user.avatar_url
            },
            accessToken,
            refreshToken
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// POST /auth/logout - Logout user
router.post('/logout', verifyToken, async (req, res) => {
    try {
        const refreshToken = req.body.refreshToken;

        if (refreshToken) {
            await db.query(
                'UPDATE user_sessions SET is_active = FALSE WHERE refresh_token = ?',
                [refreshToken]
            );
        }

        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ error: 'Logout failed' });
    }
});

// POST /auth/refresh-token - Refresh access token
router.post('/refresh-token', async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({ error: 'Refresh token required' });
        }

        // Verify refresh token
        const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);

        // Check if session exists and is active
        const [sessions] = await db.query(
            `SELECT * FROM user_sessions 
             WHERE refresh_token = ? AND is_active = TRUE AND expires_at > NOW()`,
            [refreshToken]
        );

        if (sessions.length === 0) {
            return res.status(401).json({ error: 'Invalid or expired refresh token' });
        }

        // Generate new access token
        const accessToken = jwt.sign(
            { userId: decoded.userId, tenantId: decoded.tenantId },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
        );

        res.json({ accessToken });

    } catch (error) {
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Invalid refresh token' });
        }
        console.error('Token refresh error:', error);
        res.status(500).json({ error: 'Token refresh failed' });
    }
});

// POST /auth/forgot-password - Send password reset email
router.post('/forgot-password', [body('email').isEmail()], async (req, res) => {
    try {
        const { email } = req.body;

        const [users] = await db.query(
            'SELECT id, first_name FROM users WHERE email = ? AND status = "active"',
            [email]
        );

        // Always return success to prevent email enumeration
        if (users.length === 0) {
            return res.json({ message: 'If the email exists, a reset link has been sent' });
        }

        const user = users[0];
        const resetToken = crypto.randomBytes(32).toString('hex');
        const hashedToken = await bcrypt.hash(resetToken, 10);
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

        // Store reset token (you might want a separate table for this)
        await db.query(
            `INSERT INTO user_sessions (user_id, refresh_token, expires_at, device_info) 
             VALUES (?, ?, ?, 'password-reset')`,
            [user.id, hashedToken, expiresAt]
        );

        // Send email
        const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}&email=${email}`;
        
        await sendEmail({
            to: email,
            subject: 'Password Reset Request',
            html: `
                <h2>Hello ${user.first_name},</h2>
                <p>You requested a password reset. Click the link below to reset your password:</p>
                <a href="${resetUrl}">Reset Password</a>
                <p>This link expires in 1 hour.</p>
                <p>If you didn't request this, please ignore this email.</p>
            `
        });

        res.json({ message: 'If the email exists, a reset link has been sent' });

    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ error: 'Failed to process request' });
    }
});

// GET /auth/me - Get current user profile
router.get('/me', verifyToken, async (req, res) => {
    try {
        const [users] = await db.query(
            `SELECT u.id, u.email, u.first_name, u.last_name, u.avatar_url, u.phone,
                    u.preferences, u.last_login, t.name as tenant_name, t.plan
             FROM users u
             JOIN tenants t ON u.tenant_id = t.id
             WHERE u.id = ?`,
            [req.user.id]
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
            [req.user.id]
        );

        res.json({
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            avatar: user.avatar_url,
            phone: user.phone,
            preferences: user.preferences,
            lastLogin: user.last_login,
            tenant: {
                id: req.user.tenantId,
                name: user.tenant_name,
                plan: user.plan
            },
            roles: roles,
            permissions: req.user.permissions
        });

    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

// POST /auth/change-password - Change password
router.post('/change-password', 
    verifyToken,
    [
        body('currentPassword').notEmpty(),
        body('newPassword').isLength({ min: 8 })
    ],
    async (req, res) => {
        try {
            const { currentPassword, newPassword } = req.body;

            // Get current password hash
            const [users] = await db.query(
                'SELECT password_hash FROM users WHERE id = ?',
                [req.user.id]
            );

            if (users.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }

            // Verify current password
            const validPassword = await bcrypt.compare(currentPassword, users[0].password_hash);
            if (!validPassword) {
                return res.status(401).json({ error: 'Current password is incorrect' });
            }

            // Hash new password
            const newPasswordHash = await bcrypt.hash(newPassword, 10);

            // Update password
            await db.query(
                'UPDATE users SET password_hash = ? WHERE id = ?',
                [newPasswordHash, req.user.id]
            );

            res.json({ message: 'Password changed successfully' });

        } catch (error) {
            console.error('Change password error:', error);
            res.status(500).json({ error: 'Failed to change password' });
        }
    }
);

// GET /auth/sessions - Get active sessions
router.get('/sessions', verifyToken, async (req, res) => {
    try {
        const [sessions] = await db.query(
            `SELECT id, device_info, ip_address, created_at, last_used, 
                    CASE WHEN expires_at > NOW() THEN TRUE ELSE FALSE END as is_valid
             FROM user_sessions
             WHERE user_id = ? AND is_active = TRUE
             ORDER BY last_used DESC`,
            [req.user.id]
        );

        res.json(sessions);

    } catch (error) {
        console.error('Get sessions error:', error);
        res.status(500).json({ error: 'Failed to fetch sessions' });
    }
});

// DELETE /auth/sessions/:id - Logout specific session
router.delete('/sessions/:id', verifyToken, async (req, res) => {
    try {
        const { id } = req.params;

        await db.query(
            'UPDATE user_sessions SET is_active = FALSE WHERE id = ? AND user_id = ?',
            [id, req.user.id]
        );

        res.json({ message: 'Session terminated' });

    } catch (error) {
        console.error('Delete session error:', error);
        res.status(500).json({ error: 'Failed to terminate session' });
    }
});

module.exports = router;