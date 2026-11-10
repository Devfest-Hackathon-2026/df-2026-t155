export interface DiscoveryDestination {
  id: string
  title: string
  theme: string
  region: string
  preferences: string
  image: string
  imageAlt: string
}

// Static photo themes only. These presets are drafts, not place matches or saved destinations.
export const discoveryDestinations: readonly DiscoveryDestination[] = [
  {
    id: 'castle',
    title: '名古屋城',
    theme: '城と歴史',
    region: '名古屋市',
    preferences: '歴史的な建築や街並みを楽しみたい',
    image: '/images/nagoya/castle.webp',
    imageAlt: '青空の下に建つ名古屋城',
  },
  {
    id: 'atsuta',
    title: '熱田エリア',
    theme: '神社と緑',
    region: '名古屋市熱田区',
    preferences: '緑のある場所や歴史・文化を感じる場所をゆっくり歩きたい',
    image: '/images/nagoya/atsuta.webp',
    imageAlt: '緑に囲まれた熱田神宮の社殿',
  },
  {
    id: 'oasis',
    title: '栄エリア',
    theme: '街と水辺',
    region: '名古屋市中区',
    preferences: '街並みや水辺の景色を楽しみたい',
    image: '/images/nagoya/oasis.webp',
    imageAlt: '水面に映るオアシス21',
  },
  {
    id: 'osaka-castle',
    title: '大阪城',
    theme: '城と街歩き',
    region: '大阪市',
    preferences: '歴史を感じる場所を訪ねながら街歩きを楽しみたい',
    image: '/images/cities/osaka.webp',
    imageAlt: '大阪城の天守',
  },
  {
    id: 'tokyo-tower',
    title: '東京タワー',
    theme: '名所めぐり',
    region: '東京都',
    preferences: '街を代表する建築や名所をめぐりたい',
    image: '/images/cities/tokyo.webp',
    imageAlt: '東京タワー',
  },
]
