"""Usage: python manage.py run_workers"""

import logging
import time

from django.core.management.base import BaseCommand

from core.services.heartbeat_service import HeartbeatService

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = 'Run background sync workers (heartbeat offline sweep)'

    def handle(self, *args, **options):
        self.stdout.write('Starting sync workers...')
        while True:
            try:
                count = HeartbeatService.sweep_offline()
                if count:
                    logger.info('Marked %s location(s) offline', count)
            except Exception:
                logger.exception('Worker error')
            time.sleep(30)
