#!/bin/bash

# Check that aws-vault is installed
if ! command -v aws-vault &> /dev/null; then
    echo "aws-vault is not installed. Please install it."
    exit 1
fi

# Read access and secret keys from op and set them in the environment for aws-vault to import
AWS_ACCESS_KEY_ID=$(op get item "Amazon AWS" --fields access_key)
AWS_SECRET_ACCESS_KEY=$(op get item "Amazon AWS" --fields secret_key)

# Run aws-vault to configure the AWS CLI
aws-vault add andrewb --env
