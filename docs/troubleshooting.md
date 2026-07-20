# Troubleshooting

## Common issues

### Agent build fails

- Verify that the .NET SDK is installed and that the project targets a supported framework.
- Re-run `dotnet build src/HomeworkAgent/HomeworkAgent.csproj` to capture the latest compiler diagnostics.

### Portal build fails

- Ensure Node.js is installed.
- Re-run `npm --prefix ui/app run build` after installing dependencies if needed.

### Deployment fails

- Confirm Azure Developer CLI is installed and authenticated.
- Ensure the selected subscription has the required quota and permissions.
- Review the output of the deployment script for the failing step.
