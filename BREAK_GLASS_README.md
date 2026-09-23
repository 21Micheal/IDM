# Break-Glass Login Documentation

## Overview

The break-glass login feature provides emergency access to the DMS when the primary Keycloak authentication provider is unavailable or misconfigured. This is a security-sensitive operational backdoor designed exclusively for platform administrators to regain access during IdP outages.

## Security Considerations

### ⚠️ CRITICAL SECURITY INFORMATION

- **This route is deliberately hidden from normal navigation** - it is not linked from the main login page or any user-facing UI
- **URL should be treated as sensitive information** - do not document this in user-facing help materials or public documentation
- **Access is strictly restricted** - only users with `is_staff=True` or `is_superuser=True` can successfully authenticate via this route when `AUTH_MODE=keycloak`
- **All attempts are logged distinctly** - both successful and failed break-glass login attempts create separate audit events for operational visibility

## Route Details

### URL
```
/admin/admin/
```

### Eligibility
When `AUTH_MODE=keycloak`:
- Only platform administrators (`is_staff=True` or `is_superuser=True`) can authenticate
- Regular users will be rejected even with valid credentials
- This prevents circumvention of Keycloak authentication

When `AUTH_MODE=native`:
- This route behaves identically to the main login page (no restrictions)
- The route exists for operational consistency across deployment modes

### Authentication Flow
1. User enters email and password
2. System validates credentials against DMS user table
3. If credentials are valid and user is eligible, an OTP is sent to their email
4. User enters OTP to complete authentication
5. Session is created as a normal DMS session (no Keycloak tokens involved)

## Audit Logging

### Distinct Audit Events
- `USER_BREAK_GLASS_LOGIN` - Successful break-glass login
- `USER_BREAK_GLASS_LOGIN_FAILED` - Failed break-glass attempt (invalid credentials or ineligible user)

### Audit Trail Content
- User identity (email)
- IP address
- User agent
- Timestamp
- For failures: reason (invalid credentials vs. ineligible user)
- For successes: auth mode context

### Operational Monitoring
These distinct events enable:
- Alerting on break-glass usage (indicates potential IdP issues)
- Post-incident analysis of emergency access usage
- Security audit trails for compliance

## Configuration

### AUTH_MODE Setting
Set in `IDM/settings.py` and `.env`:

```bash
# For Keycloak-connected deployments
AUTH_MODE=keycloak

# For standalone on-prem deployments
AUTH_MODE=native
```

### Default Behavior
- Default: `AUTH_MODE=native` (backward compatible)
- When `AUTH_MODE=keycloak`: Main login page shows only Keycloak button; break-glass route enforces admin-only access
- When `AUTH_MODE=native`: Main login page shows native form; break-glass route has no restrictions

## Operational Procedures

### When to Use Break-Glass Login
1. **Keycloak service outage** - When Keycloak is completely unavailable
2. **Keycloak misconfiguration** - When recent changes to Keycloak configuration prevent normal authentication
3. **Network issues to IdP** - When connectivity to Keycloak is disrupted
4. **Emergency access** - When immediate platform admin access is critical and Keycloak cannot be restored quickly

### Post-Incident Actions
After using break-glass login:
1. **Restore Keycloak** - Resolve the underlying IdP issue
2. **Review audit logs** - Check for any unusual break-glass access patterns
3. **Notify operations team** - Ensure awareness that emergency access was used
4. **Consider security review** - If break-glass was used unexpectedly, investigate potential security incidents

### Access Control
Who should know about this route:
- Platform administrators
- DevOps/engineering team
- Security operations team
- On-call engineers

Who should NOT know about this route:
- Regular users
- Customer-facing documentation
- Public-facing help materials
- Third-party contractors (unless operationally necessary)

## Technical Implementation

### Backend Components
- **Route**: `/admin/admin/` (Django template view)
- **API endpoint**: `POST /api/v1/auth/login/` (with `break_glass=true` flag)
- **Eligibility check**: `user.is_staff or user.is_superuser` when `AUTH_MODE=keycloak`
- **Audit events**: `USER_BREAK_GLASS_LOGIN`, `USER_BREAK_GLASS_LOGIN_FAILED`

### Frontend Components
- **Break-glass page**: Standalone HTML template (not part of React SPA)
- **Main login page**: Conditionally renders based on `AUTH_MODE` from `/api/v1/config/`
- **OTP verification**: Reuses existing OTP flow

### Security Layers
1. **Hidden route** - Not discoverable from normal UI
2. **Credential validation** - Requires valid DMS credentials
3. **Role restriction** - Platform admin only in keycloak mode
4. **MFA requirement** - Email OTP still required
5. **Audit logging** - All attempts logged distinctly
6. **Network protection** - Should be protected by same network security as main application

## Testing

### Test Procedure
1. Set `AUTH_MODE=keycloak` in `.env`
2. Create a test user with `is_staff=True`
3. Navigate to `/admin/admin/`
4. Attempt login with admin credentials (should succeed)
5. Attempt login with regular user credentials (should fail with "not eligible" message)
6. Check audit logs for distinct `USER_BREAK_GLASS_LOGIN` events

### Expected Behavior
- Admin users: Can authenticate, receive OTP, complete login
- Regular users: Rejected with "Native login is not available" message
- Invalid credentials: Rejected with "Invalid email or password" message
- Audit logs: Distinct events for all break-glass attempts

## Troubleshooting

### Issue: Break-glass login not working
- Verify `AUTH_MODE=keycloak` is set correctly
- Check user has `is_staff=True` or `is_superuser=True`
- Verify user account is active (`is_active=True`)
- Check email OTP delivery is working
- Review Django logs for errors

### Issue: Unexpected break-glass usage in logs
- Check for unauthorized access attempts
- Verify if Keycloak is actually unavailable
- Review IP addresses and user agents
- Consider potential security incident if pattern is suspicious

## Related Documentation

- [OIDC/Keycloak Integration](~/Projects/idp/README.md)
- [User Model Documentation](apps/accounts/models.py)
- [Audit Event Types](apps/audit/models.py)
- [Main Settings](IDM/settings.py)

## Contact

For questions about break-glass login or to report security concerns:
- Contact the platform operations team
- Review audit logs in the admin panel under `/admin/audit/auditlog/`
- Check Django application logs for detailed error information
