import request from 'supertest';
import { createApp } from '../app.js';
import { CheckoutSessionService } from '../services/checkout.js';
import { CheckoutSessionStatus } from '../types/checkout.js';

const app = createApp({ enableDocs: false });

describe('POST /api/v1/checkout/sessions/:sessionId/pay', () => {
  beforeEach(() => {
    CheckoutSessionService.clearAllSessions();
  });

  it('should process payment for a pending session', async () => {
    const sessionRes = await request(app)
      .post('/api/v1/checkout/sessions')
      .send({
        payment: { amount: 100, currency: 'USD', paymentMethod: 'credit_card' },
        customer: { customerId: 'cust1', email: 'test@example.com' }
      });
    const sessionId = sessionRes.body.session.id;

    const res = await request(app).post(`/api/v1/checkout/sessions/${sessionId}/pay`);
    
    // Status can be 200 (if success) or 200 (if failed) based on mock
    expect(res.status).toBe(200);
    expect([CheckoutSessionStatus.COMPLETED, CheckoutSessionStatus.FAILED]).toContain(res.body.session.status);
  });

  it('should return 400 for invalid session ID format', async () => {
    const res = await request(app).post('/api/v1/checkout/sessions/invalid-id/pay');
    expect(res.status).toBe(400);
  });

  it('should return 404 for non-existent session', async () => {
    const res = await request(app).post('/api/v1/checkout/sessions/00000000-0000-0000-0000-000000000000/pay');
    expect(res.status).toBe(404);
  });

  it('should return 409 for already completed session', async () => {
    const sessionRes = await request(app)
      .post('/api/v1/checkout/sessions')
      .send({
        payment: { amount: 100, currency: 'USD', paymentMethod: 'credit_card' },
        customer: { customerId: 'cust1', email: 'test@example.com' }
      });
    const sessionId = sessionRes.body.session.id;

    // Complete it first
    await request(app).post(`/api/v1/checkout/sessions/${sessionId}/complete`);

    // Try to pay again
    const res = await request(app).post(`/api/v1/checkout/sessions/${sessionId}/pay`);
    expect(res.status).toBe(409);
  });
});
