/* Connection setup stays on the paired PC. No calendar tokens enter browser storage. */
(() => {
  'use strict';

  window.createNemoIntegrations = ({ api, onUnauthorized, onChange, announce }) => {
    const ids = [
      'integrationsButton', 'settingsIntegrationsButton', 'consentRenewal', 'connectionDialog',
      'integrationsDialog', 'closeIntegrations', 'integrationsTitle',
      'dialogUseIntegrations',
      'refreshIntegrations', 'integrationsUpdated', 'integrationsMessage',
      'calendarStatus', 'calendarLastSync', 'calendarWindow', 'calendarNextStep',
      'runCalendarShortcut', 'calendarShortcutHelp', 'createCalendarToken',
      'calendarRotationNote', 'calendarTokenPanel', 'calendarTokenValue',
      'calendarEndpoint', 'copyCalendarToken', 'copyCalendarEndpoint',
      'disconnectCalendar', 'gmailStatus', 'gmailAccount', 'gmailSetup',
      'gmailCommand', 'copyGmailCommand', 'disconnectGmail', 'gmailConnectLink'
    ];
    const ui = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
    const state = {
      authenticated: false,
      loaded: false,
      status: null,
      consent: false,
      renewal: false,
      consentSaving: false,
      busy: false,
      loading: null,
      authVersion: 0,
      dialogEpoch: 0,
      opener: null
    };

    function message(text, kind = 'error') {
      ui.integrationsMessage.textContent = text;
      ui.integrationsMessage.hidden = !text;
      ui.integrationsMessage.dataset.kind = kind;
    }

    function clearToken() {
      ui.calendarTokenValue.value = '';
      ui.calendarEndpoint.value = '';
      ui.calendarTokenPanel.hidden = true;
    }

    function formatDate(value) {
      if (!value) return '';
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return '';
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    }

    function render() {
      const calendar = state.status?.calendar || {};
      const gmail = state.status?.gmail || {};
      const disabled = !state.authenticated || !state.loaded || state.busy || state.consentSaving || Boolean(state.loading);
      ui.consentRenewal.hidden = !state.renewal;
      ui.integrationsButton.disabled = !state.authenticated;
      ui.settingsIntegrationsButton.disabled = !state.authenticated;
      ui.dialogUseIntegrations.checked = state.consent;
      ui.dialogUseIntegrations.disabled = disabled;
      ui.refreshIntegrations.disabled = !state.authenticated || state.busy || state.consentSaving || Boolean(state.loading);
      ui.createCalendarToken.disabled = disabled;
      ui.disconnectCalendar.disabled = disabled;
      ui.disconnectGmail.disabled = disabled;
      ui.disconnectCalendar.hidden = !state.loaded || (!calendar.connected && !calendar.tokenActive);
      ui.disconnectGmail.hidden = !state.loaded || (!gmail.connected && !gmail.configured);
      ui.gmailConnectLink.textContent = gmail.connected ? 'Manage Gmail ↗' : 'Connect Gmail ↗';
      ui.createCalendarToken.textContent = calendar.tokenActive ? 'Replace sync token ↗' : 'Create sync token ↗';
      ui.calendarRotationNote.hidden = !calendar.tokenActive;
      ui.runCalendarShortcut.hidden = !calendar.tokenActive;
      ui.calendarShortcutHelp.hidden = !calendar.tokenActive;

      if (!state.loaded) {
        ui.calendarStatus.textContent = 'Connection not checked';
        ui.calendarLastSync.textContent = 'Last sync: not checked';
        ui.calendarWindow.hidden = true;
        ui.gmailStatus.textContent = 'Connection not checked';
        ui.gmailAccount.hidden = true;
        return;
      }

      const count = Number.isFinite(Number(calendar.count)) ? Math.max(0, Math.trunc(Number(calendar.count))) : 0;
      const lastSync = formatDate(calendar.lastSyncedAt);
      if (calendar.connected) {
        ui.calendarStatus.textContent = count === 0 ? 'Connected · no events in the synced window' : `Connected · ${count} ${count === 1 ? 'event' : 'events'} ready`;
      } else if (calendar.tokenActive) ui.calendarStatus.textContent = 'Ready for your first sync';
      else ui.calendarStatus.textContent = 'Not connected';
      ui.calendarLastSync.textContent = lastSync ? `Last sync: ${lastSync}` : 'Last sync: not synced yet';
      const windowEnd = formatDate(calendar.windowEnd);
      ui.calendarWindow.hidden = !windowEnd;
      ui.calendarWindow.textContent = windowEnd ? `Synced window ends: ${windowEnd}` : '';
      ui.calendarNextStep.textContent = calendar.tokenActive
        ? 'Run your configured iPhone shortcut to refresh the events on your PC.'
        : 'Set up an iPhone shortcut to sync the next seven days.';

      ui.gmailStatus.textContent = gmail.connected ? 'Connected' : gmail.configured ? 'Configured on PC · not connected' : 'Not configured';
      ui.gmailAccount.hidden = !gmail.connected || !gmail.account;
      ui.gmailAccount.textContent = gmail.connected && typeof gmail.account === 'string' ? gmail.account : '';
    }

    function handleError(error) {
      if (error.status === 401) {
        onUnauthorized();
        return;
      }
      message(error.message || 'This connection could not be updated. Try again.');
    }

    async function refresh({ preserveMessage = false } = {}) {
      if (!state.authenticated) return;
      if (state.loading) return state.loading;
      const version = state.authVersion;
      if (!preserveMessage) message('');
      ui.integrationsUpdated.textContent = 'Checking connections…';
      state.loading = (async () => {
        try {
          const status = await api('/api/integrations');
          if (version !== state.authVersion) return;
          state.status = status;
          state.loaded = true;
          state.consent = status.contextConsent === true;
          state.renewal = status.consentRenewalRequired === true;
          ui.integrationsUpdated.textContent = 'Status checked just now';
        } catch (error) {
          if (version !== state.authVersion) return;
          ui.integrationsUpdated.textContent = state.loaded ? 'Status could not be refreshed' : 'Status unavailable';
          handleError(error);
        } finally {
          if (version === state.authVersion) {
            state.loading = null;
            render();
            onChange();
          }
        }
      })();
      render();
      return state.loading;
    }

    function setAuthenticated(authenticated) {
      const next = Boolean(authenticated);
      if (state.authenticated === next) return;
      state.authenticated = next;
      state.authVersion += 1;
      state.loading = null;
      state.loaded = false;
      state.status = null;
      state.consent = false;
      state.renewal = false;
      state.consentSaving = false;
      state.busy = false;
      clearToken();
      if (!next && ui.integrationsDialog.open) ui.integrationsDialog.close();
      render();
      if (next) void refresh();
    }

    function open() {
      if (!state.authenticated) { onUnauthorized(); return; }
      const active = document.activeElement;
      state.opener = active?.closest?.('dialog:not([open])') ? document.querySelector('.nemo-menu-button') : active;
      if (ui.connectionDialog.open) {
        ui.connectionDialog.close();
        state.opener = document.querySelector('.nemo-profile-button') || document.getElementById('connectionButton');
      }
      state.dialogEpoch += 1;
      if (!ui.integrationsDialog.open) ui.integrationsDialog.showModal();
      ui.integrationsTitle.focus({ preventScroll: true });
      void refresh();
    }

    async function saveConsent(enabled) {
      if (!state.authenticated || !state.loaded || state.consentSaving || state.busy || state.loading) {
        render();
        return;
      }
      if (enabled === state.consent) return;
      const version = state.authVersion;
      state.consentSaving = true;
      // Keep the server's confirmed value until the update succeeds.
      render();
      onChange();
      message('');
      try {
        const result = await api('/api/integrations/consent', {
          method: 'POST', body: JSON.stringify({ enabled })
        });
        if (version !== state.authVersion) return;
        state.consent = typeof result.contextConsent === 'boolean' ? result.contextConsent : enabled;
        state.renewal = false;
        if (state.status) state.status.contextConsent = state.consent;
        announce(state.consent ? 'Your connected tools are enabled for new questions.' : 'Your connected tools are disabled for new questions.');
      } catch (error) {
        if (version !== state.authVersion) return;
        handleError(error);
        if (!ui.integrationsDialog.open && error.status !== 401) {
          // Bring the actionable error into view rather than hiding a failed opt-in.
          open();
          message(error.message || 'The context preference could not be saved.');
        }
      } finally {
        if (version === state.authVersion) {
          state.consentSaving = false;
          render();
          onChange();
        }
      }
    }

    async function mutate(path, body, afterSuccess, successMessage = '') {
      if (!state.authenticated || !state.loaded || state.busy || state.consentSaving || state.loading) return;
      const version = state.authVersion;
      state.busy = true;
      message('');
      render();
      try {
        const data = await api(path, { method: 'POST', body: JSON.stringify(body) });
        if (version !== state.authVersion) return;
        if (afterSuccess) afterSuccess(data);
        if (successMessage) message(successMessage, 'success');
        await refresh({ preserveMessage: true });
      } catch (error) {
        if (version !== state.authVersion) return;
        handleError(error);
      } finally {
        if (version === state.authVersion) {
          state.busy = false;
          render();
          onChange();
        }
      }
    }

    async function copy(value, input, label) {
      if (!value) return;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(value);
        announce(`${label} copied.`);
        message(`${label} copied.`, 'success');
      } catch {
        if (input) {
          input.focus();
          input.select();
        }
        message(`Automatic copying is unavailable. ${input ? 'The field is selected; copy it manually.' : 'Select the command and copy it manually.'}`);
      }
    }

    ui.integrationsButton.addEventListener('click', open);
    ui.settingsIntegrationsButton.addEventListener('click', open);
    ui.closeIntegrations.addEventListener('click', () => ui.integrationsDialog.close());
    ui.integrationsDialog.addEventListener('close', () => {
      state.dialogEpoch += 1;
      clearToken();
      if (state.opener instanceof HTMLElement && state.opener.isConnected) state.opener.focus({ preventScroll: true });
    });
    ui.integrationsDialog.addEventListener('click', (event) => {
      if (event.target !== ui.integrationsDialog) return;
      const rect = ui.integrationsDialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) ui.integrationsDialog.close();
    });
    ui.refreshIntegrations.addEventListener('click', () => void refresh());
    ui.dialogUseIntegrations.addEventListener('change', () => void saveConsent(ui.dialogUseIntegrations.checked));
    ui.createCalendarToken.addEventListener('click', () => {
      const epoch = state.dialogEpoch;
      clearToken();
      void mutate('/api/calendar/token', {}, (data) => {
        if (!ui.integrationsDialog.open || epoch !== state.dialogEpoch) {
          message('A sync token was created while Connections was closed. Replace it to view a new token.');
          return;
        }
        if (typeof data.token !== 'string' || !data.token || typeof data.endpoint !== 'string') {
          throw new Error('The server did not return a usable token. Create a replacement and try again.');
        }
        ui.calendarTokenValue.value = data.token;
        ui.calendarEndpoint.value = data.endpoint;
        ui.calendarTokenPanel.hidden = false;
        if (!data.endpoint) message(data.notice || 'Open Nemo using its configured phone HTTPS address to obtain a phone sync endpoint. Never use localhost on the iPhone.');
        announce('Sync token created. Copy it before closing Connections.');
      });
    });
    ui.copyCalendarToken.addEventListener('click', () => void copy(ui.calendarTokenValue.value, ui.calendarTokenValue, 'Sync token'));
    ui.copyCalendarEndpoint.addEventListener('click', () => void copy(ui.calendarEndpoint.value, ui.calendarEndpoint, 'Sync endpoint'));
    ui.copyGmailCommand.addEventListener('click', () => void copy(ui.gmailCommand.textContent, null, 'PC setup command'));
    ui.disconnectCalendar.addEventListener('click', () => void mutate('/api/calendar/disconnect', {}, clearToken, 'Calendar disconnected. Its sync token has been revoked.'));
    ui.disconnectGmail.addEventListener('click', () => void mutate('/api/gmail/disconnect', {}, (data) => {
      message(data.warning || 'Gmail disconnected.', data.warning ? 'error' : 'success');
    }));

    render();
    return {
      setAuthenticated,
      isSaving: () => state.consentSaving,
      open
    };
  };
})();
