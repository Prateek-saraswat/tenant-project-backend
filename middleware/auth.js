// middleware/auth.js - JWT Authentication Middleware
const jwt = require('jsonwebtoken');
const db = require('../config/database');

// Verify JWT Token
const verifyToken = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        
        if (!token) {
            return res.status(401).json({ error: 'Access token required' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Fetch user details
        const [users] = await db.query(
            `SELECT u.*, t.id as tenant_id, t.name as tenant_name, t.status as tenant_status
             FROM users u
             JOIN tenants t ON u.tenant_id = t.id
             WHERE u.id = ? AND u.status = 'active'`,
            [decoded.userId]
        );

        if (users.length === 0) {
            return res.status(401).json({ error: 'User not found or inactive' });
        }

        const user = users[0];

        if (user.tenant_status !== 'active') {
            return res.status(403).json({ error: 'Organization is suspended' });
        }

        // Fetch user permissions
        const [permissions] = await db.query(
            `SELECT DISTINCT p.name
             FROM permissions p
             JOIN role_permissions rp ON p.id = rp.permission_id
             JOIN user_roles ur ON rp.role_id = ur.role_id
             WHERE ur.user_id = ?`,
            [user.id]
        );

        req.user = {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            tenantId: user.tenant_id,
            tenantName: user.tenant_name,
            permissions: permissions.map(p => p.name)
        };

        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({ error: 'Invalid token' });
        }
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired' });
        }
        console.error('Auth middleware error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
};

// Check Permission
const checkPermission = (permission) => {
    return (req, res, next) => {
        if (!req.user.permissions.includes(permission)) {
            return res.status(403).json({ 
                error: 'Insufficient permissions',
                required: permission
            });
        }
        next();
    };
};

// Check Multiple Permissions (any)
const checkAnyPermission = (...permissions) => {
    return (req, res, next) => {
        const hasPermission = permissions.some(p => 
            req.user.permissions.includes(p)
        );
        
        if (!hasPermission) {
            return res.status(403).json({ 
                error: 'Insufficient permissions',
                required: permissions
            });
        }
        next();
    };
};

module.exports = {
    verifyToken,
    checkPermission,
    checkAnyPermission
};