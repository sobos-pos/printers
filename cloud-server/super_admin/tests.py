import datetime
from django.test import TestCase, Client
from django.urls import reverse
from django.utils import timezone
from django.contrib.sessions.backends.db import SessionStore

from core.models import Restaurant, Location, StaffUser
from tables.models import Table
from orders.services.order_service import OrderService
from super_admin.models import StaffInvitation


class SuperAdminTests(TestCase):
    def setUp(self):
        self.client = Client()
        
        # Create restaurant
        self.restaurant = Restaurant.objects.create(
            name="Spice Garden",
            phone="1234567890",
            is_active=True
        )
        
        # Create locations
        self.location_a = Location.objects.create(
            restaurant=self.restaurant,
            name="Branch A",
            is_active=True
        )
        self.location_b = Location.objects.create(
            restaurant=self.restaurant,
            name="Branch B",
            is_active=True
        )
        
        # Create tables
        self.table_a = Table.objects.create(
            location=self.location_a,
            label="Table A1",
            is_active=True
        )
        self.table_b = Table.objects.create(
            location=self.location_b,
            label="Table B1",
            is_active=True
        )

        # Create users
        self.owner = StaffUser.objects.create_user(
            username="owner_user",
            email="owner@example.com",
            password="password123",
            restaurant=self.restaurant,
            role="owner"
        )
        self.manager = StaffUser.objects.create_user(
            username="manager_user",
            email="manager@example.com",
            password="password123",
            restaurant=self.restaurant,
            role="manager"
        )
        self.waiter_a = StaffUser.objects.create_user(
            username="waiter_a",
            email="waitera@example.com",
            password="password123",
            restaurant=self.restaurant,
            location=self.location_a,
            role="waiter"
        )

    def test_login_and_dashboard_access(self):
        # 1. Login with invalid credentials
        response = self.client.post(reverse('super_admin_login'), {
            'email': 'owner@example.com',
            'password': 'wrongpassword'
        })
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Invalid credentials")

        # 2. Login with valid credentials
        response = self.client.post(reverse('super_admin_login'), {
            'email': 'owner@example.com',
            'password': 'password123'
        })
        self.assertRedirects(response, reverse('super_admin_dashboard'))

        # 3. Access dashboard as owner
        response = self.client.get(reverse('super_admin_dashboard'))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Branch A")
        self.assertContains(response, "Branch B")

        # 4. Access dashboard as non-authorized user (manager)
        self.client.logout()
        self.client.post(reverse('super_admin_login'), {
            'email': 'manager@example.com',
            'password': 'password123'
        })
        response = self.client.get(reverse('super_admin_dashboard'))
        # Mixin redirects to login for unauthorized users
        self.assertRedirects(response, reverse('super_admin_login'))

    def test_branch_creation(self):
        # Log in as owner
        self.client.force_login(self.owner)

        # Create new branch
        response = self.client.post(reverse('branch_create'), {
            'name': 'Branch C',
            'address': 'MG Road, Sector 5',
            'timezone': 'Asia/Kolkata'
        })
        self.assertRedirects(response, reverse('super_admin_dashboard'))
        
        # Verify it exists in DB
        branch_c = Location.objects.filter(name="Branch C").first()
        self.assertIsNotNone(branch_c)
        self.assertEqual(branch_c.restaurant, self.restaurant)

    def test_staff_creation_and_activation(self):
        # Log in as owner
        self.client.force_login(self.owner)

        # Create staff account
        response = self.client.post(reverse('invite_create'), {
            'username': 'new_waiter',
            'email': 'new_waiter@example.com',
            'role': 'waiter',
            'location_id': str(self.location_b.id),
            'password': 'tempPassword123'
        })
        self.assertRedirects(response, reverse('super_admin_dashboard'))

        # Verify inactive user & invitation in DB
        new_user = StaffUser.objects.filter(username="new_waiter").first()
        self.assertIsNotNone(new_user)
        self.assertFalse(new_user.is_active)
        self.assertEqual(new_user.location, self.location_b)

        invitation = StaffInvitation.objects.filter(user=new_user).first()
        self.assertIsNotNone(invitation)
        self.assertFalse(invitation.is_accepted)

        # Log out admin
        self.client.logout()

        # Access activation page
        activation_url = reverse('staff_activate', kwargs={'token': invitation.token})
        response = self.client.get(activation_url)
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "new_waiter")

        # Submit wrong password
        response = self.client.post(activation_url, {
            'password': 'wrongpassword'
        })
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Invalid password")

        # Submit correct password
        response = self.client.post(activation_url, {
            'password': 'tempPassword123'
        })
        self.assertRedirects(response, '/pos/')

        # Verify user is now active & invitation is accepted
        new_user.refresh_from_db()
        self.assertTrue(new_user.is_active)

        invitation.refresh_from_db()
        self.assertTrue(invitation.is_accepted)

    def test_api_security_tables_list(self):
        # Setup session token for waiter_a
        session = SessionStore()
        session['_auth_user_id'] = str(self.waiter_a.id)
        session.create()
        token = f"tok_{session.session_key}"

        # Request Location A (waiter_a's branch) -> should succeed
        headers = {'HTTP_AUTHORIZATION': f'Bearer {token}'}
        response = self.client.get(f'/api/v1/tables/?location={self.location_a.id}', **headers)
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, "Table A1")

        # Request Location B (other branch) -> should return 403 Forbidden
        response = self.client.get(f'/api/v1/tables/?location={self.location_b.id}', **headers)
        self.assertEqual(response.status_code, 403)
        self.assertContains(response, "You do not have access to this location", status_code=403)

    def test_api_security_order_creation(self):
        # Order items input
        items = []

        # waiter_a creating order for Table A1 (own branch) -> should succeed
        order_a = OrderService.create_order(
            table_uuid=str(self.table_a.id),
            source="Waiter_App",
            items=items,
            created_by=self.waiter_a
        )
        self.assertEqual(order_a.location, self.location_a)

        # waiter_a creating order for Table B1 (other branch) -> should raise ValueError
        with self.assertRaises(ValueError) as context:
            OrderService.create_order(
                table_uuid=str(self.table_b.id),
                source="Waiter_App",
                items=items,
                created_by=self.waiter_a
            )
        self.assertIn("You do not have access to place orders for this location", str(context.exception))

    def test_dashboard_shows_orders_with_waiter(self):
        from orders.services.order_service import OrderService

        OrderService.create_order(
            table_uuid=str(self.table_a.id),
            source='Waiter_App',
            items=[],
            created_by=self.waiter_a,
        )

        self.client.force_login(self.owner)
        response = self.client.get(reverse('super_admin_dashboard'))
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'Orders &amp; Waiter Tracking')
        self.assertContains(response, 'waiter_a')
        self.assertContains(response, 'Table A1')

    def test_dashboard_order_filters(self):
        from orders.services.order_service import OrderService

        OrderService.create_order(
            table_uuid=str(self.table_a.id),
            source='Waiter_App',
            items=[],
            created_by=self.waiter_a,
        )

        self.client.force_login(self.owner)
        response = self.client.get(
            reverse('super_admin_dashboard'),
            {'waiter': str(self.waiter_a.id), 'status': 'Pending'},
        )
        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'waiter_a')
