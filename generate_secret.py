import secrets
import base64
import os

def generate_secret_key(length=32):
    """Generates a strong secret key for JWT."""
    random_bytes = secrets.token_bytes(length)
    secret_key = base64.b64encode(random_bytes).decode('utf-8')
    return secret_key

def create_env_file(secret_key, out_path=".env"):
    """Creates a .env file with the generated secret key and template."""
    env_content = f"""# JWT Secret Key (keep this secret!)
SECRET_KEY={secret_key}

# Primary SMTP — Gmail (recommended)
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password-here

# Primary SMTP — Custom (alternative to Gmail, leave blank if using Gmail above)
# SMTP_HOST=smtp.yourprovider.com
# SMTP_PORT=587
# SMTP_USER=your-smtp-user
# SMTP_PASS=your-smtp-password

# Backup SMTP — used automatically if primary fails (optional but recommended)
# SMTP_BACKUP_HOST=smtp.backupprovider.com
# SMTP_BACKUP_PORT=587
# SMTP_BACKUP_USER=your-backup-user
# SMTP_BACKUP_PASS=your-backup-password

# Application URL (used for check-in links)
APP_URL=http://localhost:3000

# Server Port
PORT=3000
"""

    if os.path.exists(out_path):
        print(f"⚠️  {out_path} already exists. Backup created as {out_path}.backup")
        os.rename(out_path, out_path + '.backup')

    with open(out_path, 'w') as f:
        f.write(env_content)

    print("✅ .env file created successfully!")

if __name__ == "__main__":
    import sys

    # --auto flag: non-interactive mode for Docker/Start9 entrypoint
    if "--auto" in sys.argv:
        out_path = ".env"
        if "--out" in sys.argv:
            out_path = sys.argv[sys.argv.index("--out") + 1]
        secret_key = generate_secret_key()
        create_env_file(secret_key, out_path)
        print(f"✅ Auto-generated {out_path} with SECRET_KEY")
        sys.exit(0)

    print("🔐 Deploy: Deadman Switch - Secret Key Generator")
    print("=" * 50)

    secret_key = generate_secret_key()
    print(f"Generated Secret Key: {secret_key}")

    create_env = input("\nCreate .env file with this key? (y/n): ").lower().strip()
    if create_env in ['y', 'yes']:
        create_env_file(secret_key)
        print("\n📝 Next steps:")
        print("1. Update EMAIL_USER and EMAIL_PASS in .env file")
        print("2. Run: node server.js")
        print("3. Open: http://localhost:3000")
    else:
        print(f"\n📋 Add this to your .env file:")
        print(f"SECRET_KEY={secret_key}")
