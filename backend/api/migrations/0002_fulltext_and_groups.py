"""MySQL FULLTEXT index for the retrieval fallback + the pharmacist group."""
from django.db import migrations


def fulltext(apps, schema_editor):
    if schema_editor.connection.vendor == "mysql":
        schema_editor.execute("CREATE FULLTEXT INDEX corpus_chunks_text_ft ON corpus_chunks (text)")


def drop_fulltext(apps, schema_editor):
    if schema_editor.connection.vendor == "mysql":
        schema_editor.execute("DROP INDEX corpus_chunks_text_ft ON corpus_chunks")


def pharmacist_group(apps, schema_editor):
    apps.get_model("auth", "Group").objects.get_or_create(name="pharmacist")


class Migration(migrations.Migration):
    atomic = False
    dependencies = [("api", "0001_initial"), ("auth", "0012_alter_user_first_name_max_length")]
    operations = [
        migrations.RunPython(fulltext, drop_fulltext),
        migrations.RunPython(pharmacist_group, migrations.RunPython.noop),
    ]
