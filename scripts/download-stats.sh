#!/bin/bash
# Get download stats for Paprwork releases

echo "📊 Paprwork Download Statistics"
echo "================================"
echo ""

# Get total downloads across all releases
TOTAL=$(gh api repos/Papr-ai/paprwork/releases --jq '[.[] | .assets[].download_count] | add')
echo "Total Downloads: $TOTAL"
echo ""

# Get per-version breakdown
echo "By Version:"
gh api repos/Papr-ai/paprwork/releases --jq '.[] | select(.tag_name | startswith("v2.0")) | {version: .tag_name, downloads: ([.assets[].download_count] | add), published: .published_at}' | \
  jq -r '"\(.version): \(.downloads) downloads (\(.published | split("T")[0]))"' | \
  head -20

echo ""
echo "Latest 5 releases:"
gh release list --repo Papr-ai/paprwork --limit 5
