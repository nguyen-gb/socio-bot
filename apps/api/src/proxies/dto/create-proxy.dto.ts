import {
  IsEnum,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export enum ProxyProtocolDto {
  HTTP = 'HTTP',
  HTTPS = 'HTTPS',
  SOCKS5 = 'SOCKS5',
}

export class CreateProxyDto {
  @IsString()
  name!: string;

  @IsEnum(ProxyProtocolDto)
  protocol!: ProxyProtocolDto;

  @IsString()
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65_535)
  port!: number;

  @IsOptional()
  @Matches(/^(env:\/\/[A-Z][A-Z0-9_]{2,127}|file:\/\/[a-zA-Z0-9._/-]{1,255})$/)
  credentialsRef?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  username?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  password?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  accountIds?: string[];
}
