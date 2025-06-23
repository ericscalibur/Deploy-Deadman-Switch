import secrets
import base64
import os

def generate_secret_key(length=32):
    """Generates a strong secret key for JWT."""
    random_bytes = secrets.token_bytes(length)
    secret_key = base64.b64encode(random_bytes).decode('utf-8')
    return secret_key

def create_env_file(secret_key):
    """Creates a .env file with the generated secret key and template."""
    env_content = f"""# JWT Secret Key (keep this secret!)
SECRET_KEY={secret_key}

# Gmail SMTP Configuration
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password-here

# Application URL (used for check-in links)
APP_URL=http://localhost:3000

# Server Port
PORT=3000
"""

    if os.path.exists('.env'):
        print("⚠️  .env file already exists. Backup created as .env.backup")
        os.rename('.env', '.env.backup')

    with open('.env', 'w') as f:
        f.write(env_content)

    print("✅ .env file created successfully!")

if __name__ == "__main__":
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
