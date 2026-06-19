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


class AttendanceGeofenceTests(TestCase):
    # Connaught Place, New Delhi as the geofence centre.
    LAT, LNG = 28.6139, 77.2090

    def setUp(self):
        self.client = Client()
        self.restaurant = Restaurant.objects.create(name='Geo Co')
        self.location = Location.objects.create(
            restaurant=self.restaurant, name='Main',
            latitude=self.LAT, longitude=self.LNG, geofence_radius_m=200,
        )
        self.user = StaffUser.objects.create(
            username='w', email='w@x.com', role='waiter',
            restaurant=self.restaurant, location=self.location,
        )
        self.user.set_password('pw12345')
        self.user.save()
        self.token = self.client.post(
            '/api/v1/auth/login/',
            data=json.dumps({'email': 'w@x.com', 'password': 'pw12345'}),
            content_type='application/json',
        ).json()['session_token']

    def _auth(self):
        return {'HTTP_AUTHORIZATION': f'Bearer {self.token}'}

    def _clock_in(self, body):
        return self.client.post(
            '/api/v1/attendance/clock-in/',
            data=json.dumps(body), content_type='application/json', **self._auth(),
        )

    def test_login_context_includes_geofence(self):
        body = self.client.post(
            '/api/v1/auth/login/',
            data=json.dumps({'email': 'w@x.com', 'password': 'pw12345'}),
            content_type='application/json',
        ).json()
        loc = body['user']['location']
        self.assertAlmostEqual(loc['latitude'], self.LAT)
        self.assertAlmostEqual(loc['longitude'], self.LNG)
        self.assertEqual(loc['geofence_radius_m'], 200)

    def test_clock_in_requires_coords_when_geofenced(self):
        res = self._clock_in({})
        self.assertEqual(res.status_code, 422)
        self.assertEqual(res.json()['error']['code'], 'LOCATION_REQUIRED')

    def test_clock_in_rejected_outside_fence(self):
        res = self._clock_in({'latitude': 28.70, 'longitude': 77.30})
        self.assertEqual(res.status_code, 403)
        err = res.json()['error']
        self.assertEqual(err['code'], 'OUTSIDE_GEOFENCE')
        self.assertGreater(err['distance_m'], 200)

    def test_clock_in_allowed_within_fence(self):
        res = self._clock_in({'latitude': self.LAT, 'longitude': self.LNG})
        self.assertEqual(res.status_code, 201)
        self.assertTrue(res.json()['clocked_in'])

    def test_clock_in_anywhere_when_no_geofence(self):
        self.location.latitude = None
        self.location.longitude = None
        self.location.save()
        self.assertEqual(self._clock_in({}).status_code, 201)

    def test_history_aggregates_minutes(self):
        from datetime import timedelta
        from django.utils import timezone
        from core.models import StaffAttendance

        # A closed 2-hour shift today.
        att = StaffAttendance.objects.create(staff_user=self.user, location=self.location)
        att.clock_out_at = att.clock_in_at + timedelta(hours=2)
        att.save()

        today = timezone.localdate()
        res = self.client.get(
            f'/api/v1/attendance/history/?from={today.replace(day=1)}&to={today}',
            **self._auth(),
        )
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertGreaterEqual(body['total_minutes'], 119)
        self.assertEqual(body['total_days'], 1)
        self.assertTrue(any(d['date'] == today.isoformat() for d in body['days']))

    def test_history_requires_auth(self):
        self.assertEqual(self.client.get('/api/v1/attendance/history/').status_code, 401)
