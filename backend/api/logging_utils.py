import logging

from engine import context


class CorrelationFilter(logging.Filter):
    """Adds correlation_id / user_id / endpoint to every JSON log line. Never logs secrets."""

    def filter(self, record):
        c = context.current()
        record.correlation_id = c.correlation_id
        record.user_id = c.user_id
        record.endpoint = c.endpoint
        return True
