import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '../composables/useSession.js';
import Handset from './Handset.vue';

const post = vi.fn();
const get = vi.fn();
const del = vi.fn();

vi.mock('../api/axios.js', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    delete: (...args: unknown[]) => del(...args),
  },
}));

interface DeviceRow {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

let devices: DeviceRow[] = [];

function installGets(role: 'admin' | 'member') {
  get.mockImplementation(async (url: string) => {
    if (url.includes('needs-setup')) return { data: { needsSetup: false } };
    if (url.includes('/api/session/me')) {
      return { data: { id: 'u1', username: role, role } };
    }
    if (url === '/api/handset/devices') return { data: { devices } };
    return { data: {} };
  });
}

async function asRole(role: 'admin' | 'member') {
  installGets(role);
  await useSession().refresh();
  await flushPromises();
}

const payload = 'moneypenny://pair?v=1&host=192.168.1.250&port=3001&code=ABCD-EFGH';

function urlsOf(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

describe('Handset pairing card', () => {
  beforeEach(() => {
    post.mockReset();
    get.mockReset();
    del.mockReset();
    devices = [];
  });

  it('lists devices and mints a code with a QR', async () => {
    devices = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        label: 'Pixel',
        createdAt: 1,
        lastSeenAt: 2,
        revokedAt: null,
      },
    ];
    await asRole('admin');
    post.mockResolvedValue({
      data: {
        code: 'ABCD-EFGH',
        expiresAt: 1_700_000_000_000,
        qrPayload: payload,
        advertise: '192.168.1.250:3001',
      },
    });

    const wrapper = mount(Handset);
    await flushPromises();

    expect(wrapper.text()).toContain('Pixel');
    expect(urlsOf(get)).toContain('/api/handset/devices');

    const mint = wrapper.findAll('button').find((b) => b.text() === 'New pair code');
    expect(mint).toBeTruthy();
    await mint!.trigger('click');
    await flushPromises();

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]).toEqual(['/api/handset/pair-codes']);
    expect(wrapper.text()).toContain('ABCD-EFGH');
    expect(wrapper.text()).toContain(payload);
    expect(wrapper.text()).toContain('192.168.1.250:3001');
    const drawing = wrapper.get('svg.pair-qr path').attributes('d');
    expect(drawing && drawing.length > 0).toBe(true);
    expect(wrapper.get('svg.pair-qr rect').attributes('fill')).toBe('#ffffff');

    const called = [...urlsOf(get), ...urlsOf(post), ...urlsOf(del)];
    expect(called.some((url) => url.includes('/api/bot/settings'))).toBe(false);
  });

  it('shows HANDSET_DISABLED and DEVICE_CAP without inventing a code', async () => {
    await asRole('admin');
    const wrapper = mount(Handset);
    await flushPromises();

    post.mockRejectedValueOnce({
      response: {
        status: 409,
        data: { error: 'handset listener disabled', code: 'HANDSET_DISABLED' },
      },
    });
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'New pair code')!
      .trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('HANDSET_DISABLED');
    expect(wrapper.text()).not.toContain('ABCD-');
    expect(wrapper.find('svg.pair-qr').exists()).toBe(false);

    post.mockRejectedValueOnce({
      response: {
        status: 409,
        data: { error: 'too many devices', code: 'DEVICE_CAP' },
      },
    });
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'New pair code')!
      .trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('DEVICE_CAP');
    expect(wrapper.find('svg.pair-qr').exists()).toBe(false);
    expect(urlsOf(post).every((url) => url === '/api/handset/pair-codes')).toBe(true);
    expect([...urlsOf(get), ...urlsOf(post)].some((url) => url.includes('/api/bot/settings'))).toBe(
      false,
    );
  });

  it('hides mint from a member and skips handset calls', async () => {
    await asRole('member');
    const before = urlsOf(get).length;
    const wrapper = mount(Handset);
    await flushPromises();

    expect(wrapper.text()).toContain('limited to admins');
    expect(wrapper.text()).not.toContain('New pair code');
    expect(
      urlsOf(get)
        .slice(before)
        .some((url) => url.includes('/api/handset')),
    ).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it('asks twice before revoking a device', async () => {
    devices = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        label: 'Pixel',
        createdAt: 1,
        lastSeenAt: 2,
        revokedAt: null,
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        label: 'Old phone',
        createdAt: 1,
        lastSeenAt: 2,
        revokedAt: 3,
      },
    ];
    await asRole('admin');
    del.mockResolvedValue({ data: undefined, status: 204 });

    const wrapper = mount(Handset);
    await flushPromises();

    expect(wrapper.text()).toContain('Revoked');
    const revokeButtons = wrapper.findAll('button').filter((b) => b.text() === 'Revoke');
    expect(revokeButtons).toHaveLength(1);
    await revokeButtons[0]!.trigger('click');
    expect(del).not.toHaveBeenCalled();

    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Confirm')!
      .trigger('click');
    await flushPromises();

    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]).toEqual([
      '/api/handset/devices/11111111-1111-1111-1111-111111111111',
    ]);
    expect(urlsOf(get).filter((url) => url === '/api/handset/devices').length).toBeGreaterThan(1);
  });
});
