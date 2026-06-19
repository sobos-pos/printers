import json

from django.contrib.sessions.backends.db import SessionStore
from django.test import TestCase, Client

from core.models import Restaurant, Location, StaffUser
from tables.models import Table


class WaiterPosAuthTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.restaurant = Restaurant.objects.create(name='Test Resto', is_active=True)
        self.location = Location.objects.create(
            restaurant=self.restaurant, name='Main', is_active=True
        )
        self.table = Table.objects.create(
            location=self.location, label='T1', is_active=True
        )
        self.waiter = StaffUser.objects.create_user(
            username='waiter1',
            email='waiter1@test.com',
            password='pass12345',
            restaurant=self.restaurant,
            location=self.location,
            role='waiter',
        )

    def _token_for(self, user):
        session = SessionStore()
        session['_auth_user_id'] = str(user.id)
        session.create()
        return f'tok_{session.session_key}'

    def test_pos_page_renders_login_overlay(self):
        response = self.client.get('/pos/')
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'Staff Sign In')
        self.assertContains(response, 'profile-section')

    def test_staff_pos_order_requires_auth(self):
        body = {
            'table_uuid': str(self.table.id),
            'source': 'Staff_POS',
            'items': [],
        }
        response = self.client.post(
            '/api/v1/orders/',
            data=json.dumps(body),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()['error']['code'], 'UNAUTHORIZED')

    def test_staff_pos_order_with_auth_succeeds(self):
        token = self._token_for(self.waiter)
        body = {
            'table_uuid': str(self.table.id),
            'source': 'Staff_POS',
            'items': [],
        }
        response = self.client.post(
            '/api/v1/orders/',
            data=json.dumps(body),
            content_type='application/json',
            HTTP_AUTHORIZATION=f'Bearer {token}',
        )
        self.assertEqual(response.status_code, 201)
        data = response.json()
        self.assertEqual(data['created_by'], str(self.waiter.id))
        self.assertEqual(data['source'], 'Staff_POS')

    def test_qr_order_still_anonymous(self):
        body = {
            'table_uuid': str(self.table.id),
            'source': 'User_App_QR',
            'items': [],
        }
        response = self.client.post(
            '/api/v1/orders/',
            data=json.dumps(body),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 201)
        self.assertIsNone(response.json()['created_by'])
