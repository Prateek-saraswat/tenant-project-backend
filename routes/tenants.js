// routes/tenants.js - Tenant/Organization Management Routes
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const db = require('../config/database');
const { verifyToken, checkPermission } = require('../middleware/auth');

router.use(verifyToken);

// Logo upload configuration
const logoStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/logos/'),
    filename: (req, file, cb) => {
        const name = 'logo-' + req.user.tenantId + path.extname(file.originalname);
        cb(null, name);
    }
});
const logoUpload = multer({ 
    storage: logoStorage, 
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files allowed'));
        }
    }
});

// GET /tenants/current - Get current tenant details
router.get('/current', async (req, res) => {
    try {
        const [tenants] = await db.query(
            'SELECT id, name, slug, logo_url, timezone, plan, plan_limits, settings FROM tenants WHERE id = ?',
            [req.user.tenantId]
        );

        if (tenants.length === 0) {
            return res.status(404).json({ error: 'Organization not found' });
        }

        res.json(tenants[0]);

    } catch (error) {
        console.error('Get tenant error:', error);
        res.status(500).json({ error: 'Failed to fetch organization' });
    }
});

// PUT /tenants - Update organization settings
router.put('/',
    checkPermission('settings.manage'),
    async (req, res) => {
        try {
            const { name, timezone, settings } = req.body;

            const updates = {};
            if (name) updates.name = name;
            if (timezone) updates.timezone = timezone;
            if (settings) updates.settings = JSON.stringify(settings);

            const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
            const values = [...Object.values(updates), req.user.tenantId];

            await db.query(
                `UPDATE tenants SET ${fields} WHERE id = ?`,
                values
            );

            res.json({ message: 'Organization updated successfully' });

        } catch (error) {
            console.error('Update tenant error:', error);
            res.status(500).json({ error: 'Failed to update organization' });
        }
    }
);

// POST /tenants/logo - Upload organization logo
router.post('/logo',
    checkPermission('settings.manage'),
    logoUpload.single('logo'),
    async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            const logoUrl = `/uploads/logos/${req.file.filename}`;

            await db.query(
                'UPDATE tenants SET logo_url = ? WHERE id = ?',
                [logoUrl, req.user.tenantId]
            );

            res.json({ 
                message: 'Logo uploaded successfully',
                logoUrl 
            });

        } catch (error) {
            console.error('Upload logo error:', error);
            res.status(500).json({ error: 'Failed to upload logo' });
        }
    }
);

// GET /tenants/audit-logs - Get audit logs
router.get('/audit-logs',
    checkPermission('settings.view'),
    async (req, res) => {
        try {
            const { limit = 100, offset = 0, action, entityType } = req.query;

            let query = `
                SELECT al.*, 
                       CONCAT(u.first_name, ' ', u.last_name) as user_name,
                       u.email as user_email
                FROM audit_logs al
                LEFT JOIN users u ON al.user_id = u.id
                WHERE al.tenant_id = ?
            `;

            const params = [req.user.tenantId];

            if (action) {
                query += ' AND al.action = ?';
                params.push(action);
            }

            if (entityType) {
                query += ' AND al.entity_type = ?';
                params.push(entityType);
            }

            query += ' ORDER BY al.created_at DESC LIMIT ? OFFSET ?';
            params.push(parseInt(limit), parseInt(offset));

            const [logs] = await db.query(query, params);

            res.json(logs);

        } catch (error) {
            console.error('Get audit logs error:', error);
            res.status(500).json({ error: 'Failed to fetch audit logs' });
        }
    }
);

module.exports = router;