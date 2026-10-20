import { PostFieldsDto } from './post-fields.dto';

/** 등록 칸. 공지사항 · FAQ 는 경로(/platform-notices · /platform-faqs)로 가른다. */
export class CreatePostDto extends PostFieldsDto {}
