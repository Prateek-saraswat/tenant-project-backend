// routes/billing.js - Billing & Subscription Routes
const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { verifyToken, checkPermission } = require('../middleware/auth');

router.use(verifyToken);

// GET /billing/plans - Get available plans
router.get('/plans', async (req, res) => {
    try {
        const plans = [
            {
                id: 'free',
                name: 'Free',
                price: 0,
                currency: 'USD',
                billing_cycle: 'monthly',
                features: [
                    '5 users',
                    '3 projects',
                    '1 GB storage',
                    'Basic support'
                ],
                limits: {
                    users: 5,
                    projects: 3,
                    storage_gb: 1
                }
            },
            {
                id: 'starter',
                name: 'Starter',
                price: 29,
                currency: 'USD',
                billing_cycle: 'monthly',
                features: [
                    '15 users',
                    '10 projects',
                    '10 GB storage',
                    'Email support',
                    'Time tracking'
                ],
                limits: {
                    users: 15,
                    projects: 10,
                    storage_gb: 10
                }
            },
            {
                id: 'professional',
                name: 'Professional',
                price: 79,
                currency: 'USD',
                billing_cycle: 'monthly',
                features: [
                    'Unlimited users',
                    'Unlimited projects',
                    '100 GB storage',
                    'Priority support',
                    'Advanced analytics',
                    'Custom roles'
                ],
                limits: {
                    users: -1,
                    projects: -1,
                    storage_gb: 100
                }
            }
        ];

        res.json(plans);
    } catch (error) {
        console.error('Get plans error:', error);
        res.status(500).json({ error: 'Failed to fetch plans' });
    }
});

// GET /billing/usage - Get current usage
router.get('/usage', async (req, res) => {
    try {
        const [usage] = await db.query(
            `SELECT 
                (SELECT COUNT(*) FROM users WHERE tenant_id = ? AND status = 'active') as users_count,
                (SELECT COUNT(*) FROM projects WHERE tenant_id = ? AND status = 'active') as projects_count,
                (SELECT COALESCE(SUM(file_size), 0) FROM task_attachments ta 
                 JOIN tasks t ON ta.task_id = t.id 
                 WHERE t.tenant_id = ?) as storage_bytes`,
            [req.user.tenantId, req.user.tenantId, req.user.tenantId]
        );

        // Get tenant limits
        const [tenant] = await db.query(
            'SELECT plan, plan_limits FROM tenants WHERE id = ?',
            [req.user.tenantId]
        );

        const limits = JSON.parse(tenant[0].plan_limits || '{}');

        res.json({
            current: {
                users: usage[0].users_count,
                projects: usage[0].projects_count,
                storage_gb: (usage[0].storage_bytes / (1024 * 1024 * 1024)).toFixed(2)
            },
            limits: limits,
            plan: tenant[0].plan,
            percentages: {
                users: limits.users > 0 ? (usage[0].users_count / limits.users * 100).toFixed(1) : 0,
                projects: limits.projects > 0 ? (usage[0].projects_count / limits.projects * 100).toFixed(1) : 0,
                storage: limits.storage_gb > 0 ? (usage[0].storage_bytes / (limits.storage_gb * 1024 * 1024 * 1024) * 100).toFixed(1) : 0
            }
        });

    } catch (error) {
        console.error('Get usage error:', error);
        res.status(500).json({ error: 'Failed to fetch usage' });
    }
});

// POST /billing/subscribe - Subscribe to a plan
router.post('/subscribe',
    checkPermission('billing.manage'),
    async (req, res) => {
        try {
            const { planId, billingCycle = 'monthly' } = req.body;

            // Plan prices (hardcoded for demo - integrate with Stripe in production)
            const planPrices = {
                free: 0,
                starter: billingCycle === 'monthly' ? 29 : 290,
                professional: billingCycle === 'monthly' ? 79 : 790
            };

            const planLimits = {
                free: { users: 5, projects: 3, storage_gb: 1 },
                starter: { users: 15, projects: 10, storage_gb: 10 },
                professional: { users: -1, projects: -1, storage_gb: 100 }
            };

            // Update tenant plan
            await db.query(
                'UPDATE tenants SET plan = ?, plan_limits = ? WHERE id = ?',
                [planId, JSON.stringify(planLimits[planId]), req.user.tenantId]
            );

            // Create subscription record
            const now = new Date();
            const periodEnd = new Date(now);
            periodEnd.setMonth(periodEnd.getMonth() + (billingCycle === 'monthly' ? 1 : 12));

            await db.query(
                `INSERT INTO subscriptions (tenant_id, plan, status, billing_cycle, amount, 
                                           current_period_start, current_period_end) 
                 VALUES (?, ?, 'active', ?, ?, ?, ?)`,
                [req.user.tenantId, planId, billingCycle, planPrices[planId], now, periodEnd]
            );

            res.json({ message: 'Subscription activated successfully' });

        } catch (error) {
            console.error('Subscribe error:', error);
            res.status(500).json({ error: 'Failed to subscribe' });
        }
    }
);

// GET /billing/invoices - Get invoices
router.get('/invoices', checkPermission('billing.view'), async (req, res) => {
    try {
        const [invoices] = await db.query(
            `SELECT * FROM invoices 
             WHERE tenant_id = ? 
             ORDER BY billing_date DESC 
             LIMIT 50`,
            [req.user.tenantId]
        );

        res.json(invoices);

    } catch (error) {
        console.error('Get invoices error:', error);
        res.status(500).json({ error: 'Failed to fetch invoices' });
    }
});

module.exports = router;