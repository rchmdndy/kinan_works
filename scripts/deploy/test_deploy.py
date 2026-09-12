"""Non-destructive validation of the deployment command boundary."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent


class DeploymentBoundary(unittest.TestCase):
    def test_rejects_invalid_commands_without_sudo(self):
        for command in ("", "bash", "deploy latest", "deploy sha-" + "a" * 39,
                        "deploy sha-" + "a" * 40 + "; id",
                        "deploy sha-" + "a" * 40 + " extra"):
            result = subprocess.run(
                ["bash", str(ROOT / "ssh-command.sh")],
                env={**os.environ, "SSH_ORIGINAL_COMMAND": command},
                capture_output=True,
            )
            self.assertEqual(result.returncode, 64, command)

    def test_valid_command_has_exact_privileged_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            sudo = Path(directory) / "sudo"
            sudo.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            sudo.chmod(0o700)
            tag = "sha-" + "a" * 40
            result = subprocess.run(
                ["bash", str(ROOT / "ssh-command.sh")],
                env={**os.environ, "PATH": directory + ":" + os.environ["PATH"],
                     "SSH_ORIGINAL_COMMAND": "deploy " + tag},
                capture_output=True, text=True, check=True,
            )
            self.assertEqual(result.stdout.splitlines(),
                             ["-n", "/usr/local/sbin/kinan-deploy", tag])

    def test_shell_syntax(self):
        for script in ("deploy.sh", "ssh-command.sh"):
            subprocess.run(["bash", "-n", str(ROOT / script)], check=True)


if __name__ == "__main__":
    unittest.main()
