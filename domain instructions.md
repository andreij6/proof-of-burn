# Setting up a GoDaddy Domain for your ICP Canister

**Domain:** `icdex.app`

**Canister ID:** `kyclk-5qaaa-aaaap-quthq-cai`

Because GoDaddy blocks CNAME records on root domains (i.e., `icdex.app` without the `www`), the most reliable method using GoDaddy's DNS is to attach the canister to `www.icdex.app` and set up automatic domain forwarding for the root.

Here is the exact step-by-step process.

## Step 1: Configure GoDaddy DNS Records

Log into GoDaddy, navigate to the **DNS Management** page for `icdex.app`, and add these three new records:

### Record 1 (Routing)

- **Type:** `CNAME`
    
- **Name:** `www`
    
- **Value:** `www.icdex.app.ic-domain.live.icp1.io`
    

### Record 2 (SSL Certificate Provisioning)

- **Type:** `CNAME`
    
- **Name:** `_acme-challenge.www`
    
- **Value:** `_acme-challenge.www.icdex.app.ic-domain.live.icp2.io`
    

### Record 3 (Canister Verification)

- **Type:** `TXT`
    
- **Name:** `_canister-id.www`
    
- **Value:** `kyclk-5qaaa-aaaap-quthq-cai`
    

> **Domain Forwarding Setup:**
> 
> While still on the GoDaddy DNS page, scroll down to the **Forwarding** section. Set your root domain (`icdex.app`) to forward to `https://www.icdex.app`. Make sure to select **Permanent (301)** as the forward type.

## Step 2: Create the `ic-domains` File in Your Project

The ICP network requires proof within your files that your canister allows this specific domain.

1. Navigate to your project's frontend assets directory (usually `src/your_frontend/assets`, `public`, or `static`).
    
2. Create a folder named `.well-known`.
    
3. Inside `.well-known`, create a file named exactly `ic-domains` (do not add a file extension like `.txt`).
    
4. Paste this exact text inside that file:
    
    ```
    www.icdex.app
    ```
    
5. **Crucial:** By default, the `dfx` tool ignores hidden folders (folders starting with a dot). To fix this, create a file named `.ic-assets.json` in the same directory that houses your `.well-known` folder and add this code:
    
    ```
    [
      {
        "match": ".well-known",
        "ignore": false
      }
    ]
    ```
    

## Step 3: Deploy the Canister

Push your updated files to the mainnet. Open your terminal and run:

```
dfx deploy --network ic
```

**Verification:** To ensure the file uploaded correctly, visit your canister's raw URL:

[`https://kyclk-5qaaa-aaaap-quthq-cai.icp0.io/.well-known/ic-domains`](https://kyclk-5qaaa-aaaap-quthq-cai.icp0.io/.well-known/ic-domains "null")

_(Your browser should download or display a file that just says `www.icdex.app`)_.

## Step 4: Register the Domain with the ICP Network

Finally, you need to trigger the Internet Computer to generate your Let's Encrypt SSL certificate and map the domain route. Run this command in your computer's terminal:

```
curl -sL -X POST "https://icp.net/custom-domains/v1/www.icdex.app"
```

You will receive a JSON response. It usually takes a few minutes for the network to provision the SSL certificate.

You can check the real-time status of your registration by running:

```
curl -sL -X GET "https://icp.net/custom-domains/v1/www.icdex.app"
```

Once the state returns `"Available"`, your GoDaddy domain is fully connected! Anyone who goes to `icdex.app` or `www.icdex.app` will securely load your smart contract.

_Note: If you want the bare root domain `icdex.app` to host the site directly without the "www" forwarder, you cannot use GoDaddy's default DNS. You will need to sign up for a free Cloudflare account, change your GoDaddy Nameservers to point to Cloudflare, and set up the CNAME records in Cloudflare using `@` instead of `www` (as Cloudflare supports CNAME flattening)._