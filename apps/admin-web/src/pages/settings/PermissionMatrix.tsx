import { PERMISSIONS, ROLES, hasPermission } from '@fdp/auth/browser';
import type { Permission, Role } from '@fdp/auth/browser';
import { useState } from 'react';
import { FilterBar } from '../../components/FilterBar.js';
import { Input } from '../../components/ui.js';
import { useI18n } from '../../i18n/i18n.js';
import { roleDisplayName } from './settings-state.js';

const permissionsByModule = new Map<string, Permission[]>();
for (const permission of PERMISSIONS) {
  const module = permission.slice(0, permission.indexOf(':'));
  const permissions = permissionsByModule.get(module) ?? [];
  if (permissions.length === 0) permissionsByModule.set(module, permissions);
  permissions.push(permission);
}

export function PermissionMatrix() {
  const { t } = useI18n();
  const [role, setRole] = useState<Role | ''>('');
  const [search, setSearch] = useState('');
  const roles = role === '' ? ROLES : [role];
  const query = search.trim().toLowerCase();
  const groups = Array.from(permissionsByModule, ([module, permissions]) => {
    const label = t(`rbac.module.${module}`);
    return {
      module,
      label,
      permissions: permissions.filter(
        (permission) => permission.includes(query) || label.toLowerCase().includes(query),
      ),
    };
  }).filter(({ permissions }) => permissions.length > 0);

  return (
    <section className="detail-card detail-stack" data-testid="rbac-matrix" aria-label={t('page.38d9705d3fe6')}>
      <header>
        <h4>{t('page.3899d000246c')}</h4>
        <p className="field-hint">{t('rbac.explanation')}</p>
      </header>
      <FilterBar>
        <div className="filter-field">
          <label htmlFor="rbac-role">{t('rbac.roleFilter')}</label>
          <select id="rbac-role" value={role} onChange={(event) => setRole(event.target.value as Role | '')}>
            <option value="">{t('rbac.allRoles')}</option>
            {ROLES.map((candidate) => (
              <option key={candidate} value={candidate}>
                {roleDisplayName(candidate)}
              </option>
            ))}
          </select>
        </div>
        <div className="filter-field">
          <label htmlFor="rbac-search">{t('rbac.search')}</label>
          <Input id="rbac-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
      </FilterBar>
      {groups.length === 0 ? (
        <p role="status" className="empty-state">
          {t('rbac.empty')}
        </p>
      ) : (
        <div className="table-scroll" role="region" aria-label={t('page.38d9705d3fe6')} tabIndex={0}>
          <table
            className="rbac-table"
            data-testid="rbac-table"
            data-comparison={role === ''}
            aria-label={t('page.38d9705d3fe6')}
          >
            <thead>
              <tr>
                <th scope="col">{t('rbac.permission')}</th>
                {roles.map((candidate) => (
                  <th scope="col" key={candidate}>
                    {roleDisplayName(candidate)}
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map(({ module, label, permissions }) => (
              <tbody key={module} aria-label={label}>
                <tr className="rbac-module">
                  <th scope="rowgroup" colSpan={roles.length + 1}>
                    {label}
                  </th>
                </tr>
                {permissions.map((permission) => (
                  <tr key={permission}>
                    <th scope="row">
                      <code>{permission}</code>
                    </th>
                    {roles.map((candidate) => {
                      const granted = hasPermission(candidate, permission);
                      return (
                        <td key={candidate} data-testid={`rbac-${candidate}-${permission}`} data-granted={granted}>
                          <span className="detail-status-badge" data-enabled={granted}>
                            {t(granted ? 'rbac.granted' : 'rbac.denied')}
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
    </section>
  );
}
