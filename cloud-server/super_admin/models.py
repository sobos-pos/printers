import uuid
from django.db import models
from django.utils import timezone
from core.models import BaseModel, Restaurant, Location, StaffUser


class StaffInvitation(BaseModel):
    restaurant = models.ForeignKey(Restaurant, on_delete=models.CASCADE, related_name='invitations')
    location = models.ForeignKey(Location, on_delete=models.CASCADE, related_name='invitations')
    user = models.OneToOneField(StaffUser, on_delete=models.CASCADE, related_name='invitation')
    token = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    is_accepted = models.BooleanField(default=False)
    expires_at = models.DateTimeField()
    created_by = models.ForeignKey(StaffUser, on_delete=models.SET_NULL, null=True, blank=True)

    def is_expired(self):
        return timezone.now() > self.expires_at

    def __str__(self):
        return f"Invite for {self.user.email} to {self.location.name} ({self.user.role})"
