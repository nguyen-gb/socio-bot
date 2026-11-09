'use client';

import { useRef, useState, type ComponentProps } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Flex, Image, Select, Space, Typography } from 'antd';
import { Icon } from './ui';
import { useToast } from './toast';
import { readApiJson } from '../lib/api-response';

interface MediaAsset { id: string; fileName: string; contentType: string; sizeBytes: string; status: string }
const types = ['image/jpeg', 'image/png', 'image/webp'];
const maxImages = 10, maxBytes = 10 * 1024 * 1024;
const contentUrl = (id: string) => `/api/media/${encodeURIComponent(id)}/content`;

export function FacebookPostImages({ ids = [] }: { ids?: string[] }) {
  if (!ids.length) return null;
  return <div style={{ marginBottom: 16 }}><Typography.Paragraph type="secondary">{ids.length} ảnh đính kèm · Bấm ảnh để xem lớn</Typography.Paragraph>
    <Image.PreviewGroup><Flex gap={8} wrap>{ids.map((id, index) => <Image key={id} src={contentUrl(id)} alt={`Ảnh đính kèm ${index + 1}`} width={88} height={88} style={{ objectFit: 'cover', borderRadius: 8 }} />)}</Flex></Image.PreviewGroup>
  </div>;
}

export function CampaignImagePicker({ id, value = [], onChange, disabled, onUploadingChange, context = 'post', platform = 'Facebook' }: {
  id?: string;
  value?: string[];
  onChange?: (ids: string[]) => void;
  disabled?: boolean;
  onUploadingChange?: (uploading: boolean) => void;
  context?: 'post' | 'message' | 'reply';
  platform?: 'Facebook' | 'TikTok';
}) {
  const noun = context === 'message' ? 'tin nhắn' : context === 'reply' ? 'lượt rep' : 'bài viết';
  const input = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);
  const [uploading, setUploading] = useState(false);
  const cache = useQueryClient();
  const toast = useToast();
  const media = useQuery({ queryKey: ['media'], queryFn: async () => {
    const response = await fetch('/api/media', { cache: 'no-store' });
    const result = await readApiJson<MediaAsset[]>(response, '/api/media');
    if (!response.ok) throw new Error('Không tải được thư viện ảnh');
    return result;
  } });
  const images = (media.data ?? []).filter(asset => asset.status === 'READY' && types.includes(asset.contentType) && Number(asset.sizeBytes) <= maxBytes);
  const upload = async (files: File[]) => {
    if (uploadingRef.current || !files.length) return;
    if (value.length + files.length > maxImages) { toast.error(`Mỗi ${noun} tối đa 10 ảnh. Bỏ bớt ảnh rồi chọn lại.`); return; }
    if (files.some(file => !types.includes(file.type) || file.size > maxBytes || !file.size)) { toast.error('Chọn ảnh JPG, PNG hoặc WebP, tối đa 10 MB/ảnh.'); return; }
    uploadingRef.current = true; setUploading(true); onUploadingChange?.(true);
    const selected = [...value];
    let uploadedCount = 0;
    try {
      // Upload sequentially to avoid buffering many large multipart bodies on a small VPS.
      for (const file of files) {
        const form = new FormData(); form.append('file', file);
        const response = await fetch('/api/media', { method: 'POST', body: form });
        const asset = await readApiJson<MediaAsset & { message?: string | string[] }>(response, '/api/media');
        if (!response.ok) throw new Error(Array.isArray(asset.message) ? asset.message.join('. ') : asset.message ?? `Không tải được ${file.name}`);
        selected.push(asset.id);
        uploadedCount += 1;
        cache.setQueryData<MediaAsset[]>(['media'], previous => [asset, ...(previous ?? []).filter(item => item.id !== asset.id)]);
        onChange?.([...selected]);
      }
      toast.success(`Đã thêm ${files.length} ảnh vào ${noun}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Không tải được ảnh';
      toast.error(uploadedCount ? `Đã thêm ${uploadedCount}/${files.length} ảnh. ${detail}` : detail);
    }
    finally { uploadingRef.current = false; setUploading(false); onUploadingChange?.(false); }
  };
  return <Space className="campaign-image-picker" orientation="vertical" size={12} style={{ width: '100%' }}>
    <Flex className="campaign-image-picker-controls" gap={8} align="start" wrap>
      <Select id={id} aria-label="Chọn ảnh từ thư viện" mode="multiple" allowClear showSearch maxCount={maxImages} maxTagCount="responsive" style={{ flex: 1, minWidth: 0 }}
        disabled={disabled || uploading} value={value} onChange={onChange} loading={media.isLoading} optionFilterProp="label"
        placeholder="Chọn ảnh trong thư viện" notFoundContent={media.isLoading ? 'Đang tải thư viện...' : 'Chưa có ảnh trong thư viện'} options={images.map(asset => ({ value: asset.id, label: asset.fileName }))} />
      <Button icon={<Icon name="upload" />} loading={uploading} disabled={disabled || uploading || value.length >= maxImages} onClick={() => input.current?.click()}>Tải ảnh mới</Button>
      <input ref={input} type="file" aria-label={`Tải ảnh ${noun}`} accept="image/jpeg,image/png,image/webp" multiple hidden style={{ display: 'none' }} disabled={disabled || uploading}
        onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void upload(files); }} />
    </Flex>
    {media.isError ? <Typography.Text type="danger">Không tải được thư viện. <Button type="link" onClick={() => void media.refetch()}>Thử lại</Button></Typography.Text> : null}
    <Typography.Text type="secondary">{platform} · JPG, PNG, WebP · Tối đa 10 ảnh, 10 MB/ảnh. Có thể {context === 'message' ? 'gửi ảnh kèm nội dung hoặc chỉ ảnh' : context === 'reply' ? 'rep ảnh kèm nội dung hoặc chỉ ảnh' : 'đăng ảnh kèm nội dung hoặc chỉ ảnh'}.</Typography.Text>
    <Image.PreviewGroup><Flex className="campaign-image-preview-list" gap={12} wrap>{value.map((id, index) => <div className="campaign-image-preview" key={id}>
      <Image src={contentUrl(id)} alt={`Ảnh ${index + 1}`} width={88} height={88} style={{ objectFit: 'cover', borderRadius: 8 }} />
      <Flex justify="space-between" align="center"><Typography.Text type="secondary">Ảnh {index + 1}</Typography.Text><Button type="text" size="small" danger icon={<Icon name="close" />} aria-label={`Bỏ ảnh ${index + 1}`} disabled={disabled || uploading} onClick={() => onChange?.(value.filter(item => item !== id))} /></Flex>
    </div>)}</Flex></Image.PreviewGroup>
  </Space>;
}

export function FacebookImagePicker(props: Omit<ComponentProps<typeof CampaignImagePicker>, 'platform'>) {
  return <CampaignImagePicker {...props} platform="Facebook" />;
}
