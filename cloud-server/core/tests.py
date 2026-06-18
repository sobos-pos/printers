import json

import jwt
from django.test import Client, TestCase

from core.authentication import ApiKeyAuth
from core.models import Location, Restaurant, StaffUser
from core.services.staff_token_service import (
    StaffTokenError,
    mint_staff_token,
    verify_staff_token,
)


class StaffTokenServiceTests(TestCase):
    def setUp(self):
        self.restaurant = Restaurant.objects.create(name='Spice Co')
        self.location = Location.objects.create(restaurant=self.restaurant, name='HQ')
        self.user = StaffUser.objects.create(
            username='waiter1', role='waiter',
            restaurant=self.restaurant, location=self.location,
        )

    def test_restaurant_gets_secret_on_create(self):
        self.assertTrue(self.restaurant.jwt_signing_secret)
        self.assertEqual(len(self.restaurant.jwt_signing_secret), 64)

    def test_mint_and_verify_roundtrip(self):
        result = mint_staff_token(self.user)
        payload = verify_staff_token(result['access_token'], self.restaurant)
        self.assertEqual(payload['user_id'], str(self.user.id))
        self.assertEqual(payload['restaurant_id'], str(self.restaurant.id))
        self.assertEqual(payload['location_id'], str(self.location.id))
        self.assertEqual(payload['role'], 'waiter')
        self.assertEqual(payload['type'], 'staff_access')

    def test_verify_rejects_wrong_secret(self):
        token = mint_staff_token(self.user)['access_token']
        other = Restaurant.objects.create(name='Other')
        with self.assertRaises(jwt.InvalidSignatureError):
            verify_staff_token(token, other)

    def test_mint_requires_restaurant(self):
        orphan = StaffUser.objects.create(username='nobody', role='staff')
        with self.assertRaises(StaffTokenError):
            mint_staff_token(orphan)

    def test_rotate_invalidates_old_tokens(self):
        token = mint_staff_token(self.user)['access_token']
        self.restaurant.rotate_jwt_secret()
        self.restaurant.refresh_from_db()
        with self.assertRaises(jwt.InvalidSignatureError):
            verify_staff_token(token, self.restaurant)


class AuthEndpointTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.restaurant = Restaurant.objects.create(name='Spice Co')
        self.location = Location.objects.create(restaurant=self.restaurant, name='HQ')
        self.user = StaffUser.objects.create(
            username='manager1', email='m@x.com', role='manager',
            restaurant=self.restaurant, location=self.location,
        )
        self.user.set_password('pw12345')
        self.user.save()

    def _login(self):
        return self.client.post(
            '/api/v1/auth/login/',
            data=json.dumps({'email': 'm@x.com', 'password': 'pw12345'}),
            content_type='application/json',
        )

    def test_login_returns_staff_access_token(self):
        res = self._login()
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertIn('access_token', body)
        self.assertIn('expires_at', body)
        payload = verify_staff_token(body['access_token'], self.restaurant)
        self.assertEqual(payload['role'], 'manager')

    def test_staff_token_refresh_with_session(self):
        session_token = self._login().json()['session_token']
        res = self.client.post(
            '/api/v1/auth/staff-token/',
            **{'HTTP_AUTHORIZATION': f'Bearer {session_token}'},
        )
        self.assertEqual(res.status_code, 200)
        self.assertIn('access_token', res.json())

    def test_staff_token_refresh_requires_session(self):
        res = self.client.post('/api/v1/auth/staff-token/')
        self.assertEqual(res.status_code, 401)

    def test_auth_material_with_api_key(self):
        raw_key = ApiKeyAuth.issue_key(self.location)
        res = self.client.get(
            '/api/v1/sync/auth-material/',
            **{'HTTP_AUTHORIZATION': f'Api-Key {raw_key}'},
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body['restaurant_id'], str(self.restaurant.id))
        self.assertEqual(body['jwt_secret'], self.restaurant.jwt_signing_secret)

    def test_auth_material_requires_api_key(self):
        self.assertEqual(self.client.get('/api/v1/sync/auth-material/').status_code, 401)
