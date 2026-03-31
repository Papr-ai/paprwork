# Windows Code Signing Guide

**Last Updated:** 2026-03-30

## Problem

Windows users see this SmartScreen warning when launching Paprwork:

```
Windows protected your PC

Microsoft Defender SmartScreen prevented an unrecognized app from starting.
Running this app might put your PC at risk.
```

This happens because the app is **not code-signed**. Windows Defender blocks unsigned executables by default to protect users from malware.

## Impact

- **User Experience:** Extra friction, looks unprofessional
- **Trust:** Users may think the app is malware
- **Distribution:** Some enterprise environments block unsigned apps entirely

## Solutions

### Option 1: Tell Users to Click "Run Anyway" (Temporary)

**For testing/beta releases:**

1. User sees SmartScreen warning
2. Click **"More info"** at the bottom
3. Click **"Run anyway"** button
4. Windows remembers the decision for future launches

**Pros:** Free, works immediately  
**Cons:** Poor UX, reduces trust, doesn't work in strict environments

### Option 2: Code Sign the Application (Production)

**For production releases:**

Purchase a Windows code signing certificate and configure electron-builder to sign the app during build.

## Setting Up Code Signing

### Step 1: Purchase a Code Signing Certificate

**Recommended Providers:**

| Provider | Type | Price | Time to Issue | Notes |
|----------|------|-------|---------------|-------|
| **DigiCert** | EV Code Signing | $500/year | 1-7 days | Best reputation, instant trust |
| **Sectigo** | Standard Code Signing | $200/year | 1-3 days | Good value |
| **SSL.com** | EV Code Signing | $400/year | 1-5 days | Competitive pricing |
| **GlobalSign** | Code Signing | $250/year | 1-3 days | Reliable |

**What You Need:**
- Registered business (for EV certificates)
- Business documentation (articles of incorporation, tax ID)
- Identity verification (government-issued ID)
- Phone verification

**EV vs. Standard:**
- **EV (Extended Validation):** Instant SmartScreen reputation, requires hardware token, more expensive
- **Standard:** Cheaper, but needs to build reputation over time (Microsoft tracks download counts)

### Step 2: Receive Certificate

You'll receive a **`.pfx` or `.p12` file** and a **password**. This is your code signing certificate.

**Security:**
- ⚠️ **NEVER commit this to git**
- Store securely (password manager, 1Password, encrypted storage)
- Add to `.gitignore` immediately

### Step 3: Configure Environment Variables

**For local builds:**

```bash
# macOS/Linux
export CSC_LINK="/path/to/certificate.pfx"
export CSC_KEY_PASSWORD="your-certificate-password"

# Windows (PowerShell)
$env:CSC_LINK="C:\path\to\certificate.pfx"
$env:CSC_KEY_PASSWORD="your-certificate-password"
```

**For CI/CD (GitHub Actions):**

Add as **repository secrets**:
- `WINDOWS_CSC_LINK` - Base64-encoded certificate file
- `WINDOWS_CSC_KEY_PASSWORD` - Certificate password

### Step 4: electron-builder Configuration

**Already configured in `electron-builder.json`:**

```json
{
  "win": {
    "signingHashAlgorithms": ["sha256"],
    "certificateFile": "${CSC_LINK}",
    "certificatePassword": "${CSC_KEY_PASSWORD}",
    "publisherName": "Papr.ai Inc."
  }
}
```

- `signingHashAlgorithms`: Use SHA-256 (modern standard)
- `certificateFile`: Path to `.pfx` file (from `CSC_LINK` env var)
- `certificatePassword`: Certificate password (from `CSC_KEY_PASSWORD` env var)
- `publisherName`: Your company name (must match certificate)

### Step 5: Build Signed Installer

```bash
# Set environment variables
export CSC_LINK="/path/to/certificate.pfx"
export CSC_KEY_PASSWORD="your-password"

# Build Windows installer (signed)
npm run dist:win
```

**Output:** `release/Paprwork Setup 2.0.14.exe` (signed)

### Step 6: Verify Signature

**On Windows:**

1. Right-click the `.exe` file
2. Click **Properties**
3. Go to **Digital Signatures** tab
4. You should see your certificate

**Using SignTool (command line):**

```powershell
signtool verify /pa "Paprwork Setup 2.0.14.exe"
```

**Expected output:**
```
Successfully verified: Paprwork Setup 2.0.14.exe
```

## GitHub Actions CI/CD Setup

### Add Secrets

**Repository Settings → Secrets and variables → Actions:**

1. `WINDOWS_CSC_LINK`
   - **Value:** Base64-encoded certificate
   - **How to encode:**
     ```bash
     # macOS/Linux
     base64 -i certificate.pfx -o certificate.txt
     
     # Windows (PowerShell)
     [Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx")) | Out-File certificate.txt
     ```
   - Copy contents of `certificate.txt` to secret

2. `WINDOWS_CSC_KEY_PASSWORD`
   - **Value:** Certificate password (plain text)

### Workflow Example

```yaml
name: Build and Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '24'
      
      - name: Decode certificate
        run: |
          $CertBytes = [Convert]::FromBase64String("${{ secrets.WINDOWS_CSC_LINK }}")
          [IO.File]::WriteAllBytes("certificate.pfx", $CertBytes)
      
      - name: Install dependencies
        run: npm install
      
      - name: Build app
        run: npm run dist:win
        env:
          CSC_LINK: certificate.pfx
          CSC_KEY_PASSWORD: ${{ secrets.WINDOWS_CSC_KEY_PASSWORD }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      
      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: windows-installer
          path: release/*.exe
```

## Testing Code Signing

### 1. Build Locally (Signed)

```bash
export CSC_LINK="/path/to/certificate.pfx"
export CSC_KEY_PASSWORD="your-password"
npm run build
npm run dist:win
```

### 2. Verify Signature

```powershell
signtool verify /pa "release/Paprwork Setup 2.0.14.exe"
```

### 3. Test Installation

- Install on a fresh Windows VM
- Should NOT see SmartScreen warning
- Right-click `.exe` → Properties → Digital Signatures tab should show your cert

### 4. Check SmartScreen Reputation

**For new certificates:**
- First few downloads may still show SmartScreen warning
- Microsoft needs to build reputation (track download count, user feedback)
- Typically takes 1-2 weeks and 100+ downloads
- EV certificates get instant trust

## Troubleshooting

### Error: "Certificate file not found"

**Cause:** `CSC_LINK` environment variable not set  
**Solution:** Set environment variable before building

```bash
export CSC_LINK="/path/to/certificate.pfx"
```

### Error: "Invalid password"

**Cause:** Wrong certificate password  
**Solution:** Verify password, ensure no extra spaces

```bash
export CSC_KEY_PASSWORD="correct-password"
```

### Error: "Publisher name mismatch"

**Cause:** `publisherName` in `electron-builder.json` doesn't match certificate  
**Solution:** Update `publisherName` to match certificate exactly

```json
{
  "win": {
    "publisherName": "Your Company Name LLC"
  }
}
```

### SmartScreen Still Shows Warning

**Cause:** New certificate needs to build reputation  
**Solutions:**
1. Use EV certificate (instant trust)
2. Wait 1-2 weeks for reputation to build (100+ downloads needed)
3. Contact Microsoft for SmartScreen reputation boost (for high-volume apps)

## Cost Breakdown

| Solution | Annual Cost | Setup Time | Ongoing Effort | User Experience |
|----------|-------------|------------|----------------|-----------------|
| **No signing** | $0 | 0 | 0 | ❌ SmartScreen warning every time |
| **Standard cert** | $200-250 | 1-3 days | 30 min/year | ⚠️ Warning initially, then ✅ |
| **EV cert** | $400-500 | 1-7 days | 30 min/year | ✅ No warning, instant trust |

## Recommendation

**For Paprwork:**

1. **Beta/Testing:** Tell users to click "Run anyway" (temporary)
2. **Production:** Purchase EV certificate from DigiCert or Sectigo
3. **Long-term:** Renew certificate annually, automate signing in CI/CD

**Why EV?**
- Instant SmartScreen trust (no reputation building needed)
- Better user experience (no warnings)
- Professional appearance
- Worth the extra cost for commercial software

## Security Best Practices

1. ✅ **Never commit certificate to git**
   ```bash
   # .gitignore
   *.pfx
   *.p12
   certificate.*
   ```

2. ✅ **Use environment variables**
   ```bash
   export CSC_LINK="/secure/path/certificate.pfx"
   export CSC_KEY_PASSWORD="password"
   ```

3. ✅ **Store certificate securely**
   - 1Password, LastPass, or similar
   - Encrypted storage volume
   - Hardware security module (HSM) for EV certs

4. ✅ **Rotate certificates**
   - Monitor expiration dates
   - Renew 30 days before expiration
   - Update CI/CD secrets immediately after renewal

5. ✅ **Audit builds**
   - Verify signature on every release
   - Check certificate validity
   - Monitor SmartScreen reputation

## References

- [electron-builder Code Signing](https://www.electron.build/code-signing)
- [Microsoft SmartScreen](https://docs.microsoft.com/en-us/windows/security/threat-protection/microsoft-defender-smartscreen)
- [DigiCert Code Signing](https://www.digicert.com/signing/code-signing-certificates)
- [Sectigo Code Signing](https://sectigo.com/ssl-certificates-tls/code-signing)

---

**Status:** Configuration ready, certificate purchase needed  
**Next Step:** Purchase certificate from DigiCert or Sectigo
